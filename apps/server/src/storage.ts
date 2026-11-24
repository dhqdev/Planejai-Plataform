import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";
import { many, one, query } from "./db/pool.js";
import { getSettings, storageSwitchedOff } from "./settings.js";

/**
 * Arquivos fora do Postgres: storage S3 compatível (Cloudflare R2, S3, B2) configurado pelo dono.
 * Assinatura AWS SigV4 feita aqui (sem SDK). Sem as envs STORAGE_S3_*, documentos e mídias ficam no banco (bytea).
 * O endpoint é env do dono (não vem de usuário/modelo), então fetch direto com timeout.
 */
const TIMEOUT_MS = 30_000;

/** As envs STORAGE_S3_* estão na stack (mesmo com o bucket desconectado no painel). */
export function storageConfigured() {
  return Boolean(config.STORAGE_S3_ENDPOINT && config.STORAGE_S3_BUCKET && config.STORAGE_S3_ACCESS_KEY_ID && config.STORAGE_S3_SECRET_ACCESS_KEY);
}

/** Bucket em uso: envs na stack e não desconectado em Servidor > Backup. */
export function storageEnabled() {
  return storageConfigured() && !storageSwitchedOff;
}

/** Igual ao storageEnabled, mas relê as configurações antes (o botão pode ter sido tocado no outro processo). */
export async function storageOn() {
  if (!storageConfigured()) return false;
  await getSettings();
  return storageEnabled();
}

/**
 * Pastas no bucket (dentro do prefixo de STORAGE_S3_BUCKET, ex.: "planejai/planejai"):
 *   banco/      dump diário do Postgres + ficha .json de cada um (backup.ts)
 *   chaves/     cofre das chaves da stack, cifrado com a senha do dono
 *   arquivos/documentos/<id da pessoa>/<id>   e   arquivos/midia/<id>
 * Objetos antigos (documents/, media/, backups/) vão para o lugar novo aos poucos (relocateLegacyObjects).
 */
export const docKey = (userId: string, id: string) => `arquivos/documentos/${userId}/${id}`;
export const mediaKey = (id: string) => `arquivos/midia/${id}`;
export const DB_FOLDER = "banco/";
export const KEYS_FOLDER = "chaves/";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
// RFC 3986, como a AWS pede no caminho (a "/" entre partes fica)
const encodeKey = (key: string) =>
  key
    .split("/")
    .map((p) => encodeURIComponent(p).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");

const encodeQuery = (q: Record<string, string>) =>
  Object.keys(q)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(q[k]!).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`)
    .join("&");

/** STORAGE_S3_BUCKET pode levar um prefixo ("planejai/planejai" = bucket planejai, tudo dentro de planejai/). */
export function bucketParts() {
  const [bucket = "", ...rest] = config.STORAGE_S3_BUCKET.split("/").filter(Boolean);
  const prefix = rest.length ? `${rest.join("/")}/` : "";
  return { bucket, prefix };
}

interface SignOpts {
  contentType?: string;
  now?: Date;
  /** query string (ex.: list-type=2) */
  query?: Record<string, string>;
  /** cabeçalhos extras assinados (ex.: x-amz-copy-source) */
  headers?: Record<string, string>;
  /** hash do corpo quando ele vem de um arquivo (streaming) */
  payloadHash?: string;
  /** chave crua no caminho do bucket (sem o prefixo do STORAGE_S3_BUCKET), para listar */
  bucketOnly?: boolean;
}

/** Monta a requisição assinada (path-style: <endpoint>/<bucket>/<chave>). Exportada para o teste conferir a assinatura. */
export function signRequest(method: string, key: string, body: Buffer | null, opts: SignOpts = {}) {
  const base = new URL(config.STORAGE_S3_ENDPOINT);
  const prefix = base.pathname.replace(/\/+$/, "");
  const path = opts.bucketOnly ? `${prefix}/${encodeKey(bucketParts().bucket)}` : `${prefix}/${encodeKey(config.STORAGE_S3_BUCKET)}/${encodeKey(key)}`;
  const qs = opts.query ? encodeQuery(opts.query) : "";
  const url = new URL(`${base.origin}${path}${qs ? `?${qs}` : ""}`);
  const amzDate = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const region = config.STORAGE_S3_REGION || "auto";
  const payloadHash = opts.payloadHash ?? sha256(body ?? "");
  const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...opts.headers };
  if (opts.contentType) headers["content-type"] = opts.contentType;
  const names = Object.keys(headers).sort();
  const canonical = [method, path, qs, ...names.map((n) => `${n}:${headers[n]!.trim()}`), "", names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  let k: Buffer = hmac(`AWS4${config.STORAGE_S3_SECRET_ACCESS_KEY}`, day);
  for (const part of [region, "s3", "aws4_request"]) k = hmac(k, part);
  const signature = createHmac("sha256", k).update(toSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.STORAGE_S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  delete headers.host;
  return { url: url.toString(), headers };
}

async function send(method: string, key: string, body: Buffer | null, contentType?: string, opts: SignOpts = {}) {
  if (!storageEnabled()) throw new Error("Storage de arquivos não configurado");
  const { url, headers } = signRequest(method, key, body, { ...opts, contentType });
  const res = await fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return res;
}

// erro sem segredo: só método, status e o código do S3 (ex.: NoSuchKey, SignatureDoesNotMatch)
async function fail(res: Response, method: string): Promise<never> {
  const text = await res.text().catch(() => "");
  const code = text.match(/<Code>([^<]{1,60})<\/Code>/)?.[1];
  throw new Error(`Storage ${method} falhou: ${res.status}${code ? ` ${code}` : ""}`);
}

export async function putObject(key: string, data: Buffer, contentType = "application/octet-stream") {
  const res = await send("PUT", key, data, contentType);
  if (!res.ok) await fail(res, "PUT");
  await res.arrayBuffer().catch(() => null);
}

export async function getObject(key: string) {
  const res = await send("GET", key, null);
  if (!res.ok) await fail(res, "GET");
  return Buffer.from(await res.arrayBuffer());
}

/** Apagar o que já não existe não é erro. */
export async function deleteObject(key: string) {
  const res = await send("DELETE", key, null);
  if (!res.ok && res.status !== 404) await fail(res, "DELETE");
  await res.arrayBuffer().catch(() => null);
}

/** Tamanho do objeto, ou null se não existe. */
export async function headObject(key: string): Promise<{ size: number; lastModified: string | null } | null> {
  const res = await send("HEAD", key, null);
  if (res.status === 404) return null;
  if (!res.ok) await fail(res, "HEAD");
  return { size: Number(res.headers.get("content-length") ?? 0), lastModified: res.headers.get("last-modified") };
}

/** Cópia dentro do bucket, sem baixar (CopyObject). */
export async function copyObject(from: string, to: string) {
  const source = `/${encodeKey(config.STORAGE_S3_BUCKET)}/${encodeKey(from)}`;
  const res = await send("PUT", to, null, undefined, { headers: { "x-amz-copy-source": source } });
  const text = await res.text().catch(() => "");
  // o S3 pode responder 200 com <Error> no corpo
  if (!res.ok || /<Error>/.test(text)) {
    const code = text.match(/<Code>([^<]{1,60})<\/Code>/)?.[1];
    throw new Error(`Storage COPY falhou: ${res.status}${code ? ` ${code}` : ""}`);
  }
}

export interface StoredObject {
  /** chave relativa ao prefixo do STORAGE_S3_BUCKET (igual à que o app grava) */
  key: string;
  size: number;
  lastModified: string;
}

const xmlDecode = (v: string) => v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Lista objetos de uma pasta (ListObjectsV2, de 1000 em 1000), até `max`. */
export async function listObjects(folder: string, max = 50_000): Promise<{ objects: StoredObject[]; truncated: boolean }> {
  const { prefix } = bucketParts();
  const objects: StoredObject[] = [];
  let token: string | undefined;
  for (;;) {
    const query: Record<string, string> = { "list-type": "2", prefix: prefix + folder, "max-keys": "1000" };
    if (token) query["continuation-token"] = token;
    const res = await send("GET", "", null, undefined, { query, bucketOnly: true });
    if (!res.ok) await fail(res, "LIST");
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const body = m[1]!;
      const key = xmlDecode(body.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? "");
      if (!key.startsWith(prefix)) continue;
      objects.push({ key: key.slice(prefix.length), size: Number(body.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0), lastModified: body.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] ?? "" });
    }
    token = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1];
    const more = /<IsTruncated>true<\/IsTruncated>/.test(xml) && token;
    if (!more) return { objects, truncated: false };
    if (objects.length >= max) return { objects, truncated: true };
    token = xmlDecode(token!);
  }
}

/** Requisição com corpo/resposta em stream (arquivos grandes, como o dump do banco, não passam pela memória). */
function rawRequest(method: string, key: string, opts: SignOpts & { file?: string; size?: number }, timeoutMs: number): Promise<IncomingMessage> {
  const { url, headers } = signRequest(method, key, null, opts);
  const u = new URL(url);
  const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, { method, headers: { ...headers, ...(opts.size != null ? { "content-length": String(opts.size) } : {}) }, timeout: timeoutMs });
  return new Promise((resolve, reject) => {
    req.on("response", resolve);
    req.on("timeout", () => req.destroy(new Error("Storage: tempo esgotado")));
    req.on("error", reject);
    if (opts.file) createReadStream(opts.file).on("error", reject).pipe(req);
    else req.end();
  });
}

async function drainError(res: IncomingMessage, method: string): Promise<never> {
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  const code = Buffer.concat(chunks).toString("utf8").match(/<Code>([^<]{1,60})<\/Code>/)?.[1];
  throw new Error(`Storage ${method} falhou: ${res.statusCode}${code ? ` ${code}` : ""}`);
}

export async function fileSha256(file: string) {
  const h = createHash("sha256");
  for await (const c of createReadStream(file)) h.update(c as Buffer);
  return h.digest("hex");
}

/** Sobe um arquivo do disco sem carregar na memória. */
export async function putObjectFile(key: string, file: string, contentType = "application/octet-stream", hash?: string) {
  if (!storageEnabled()) throw new Error("Storage de arquivos não configurado");
  const { size } = await stat(file);
  const res = await rawRequest("PUT", key, { contentType, payloadHash: hash ?? (await fileSha256(file)), file, size }, 30 * 60_000);
  if ((res.statusCode ?? 500) >= 300) await drainError(res, "PUT");
  res.resume();
}

/** Baixa um objeto direto para o disco. */
export async function getObjectToFile(key: string, file: string) {
  if (!storageEnabled()) throw new Error("Storage de arquivos não configurado");
  const res = await rawRequest("GET", key, {}, 30 * 60_000);
  if ((res.statusCode ?? 500) >= 300) await drainError(res, "GET");
  await pipeline(res, createWriteStream(file));
}

/** Com bucket e o interruptor ligado, o arquivo fica também no banco (VM). Sem bucket fica sempre no banco. */
export async function keepLocalCopy() {
  if (!(await storageOn())) return true;
  return (await getSettings()).keepLocalCopy;
}

/**
 * Grava um arquivo novo e devolve o que vai na linha (data e storage_key).
 * Com cópia na VM, se o bucket falhar o arquivo fica só no banco e a limpeza de hora em hora sobe depois.
 */
export async function storeBlob(key: string, data: Buffer, mimetype: string): Promise<{ data: Buffer | null; storage_key: string | null }> {
  if (!(await storageOn())) return { data, storage_key: null };
  const local = await keepLocalCopy();
  try {
    await putObject(key, data, mimetype);
  } catch (err) {
    if (local) return { data, storage_key: null };
    throw err;
  }
  return { data: local ? data : null, storage_key: key };
}

/** Quantos arquivos têm cópia na VM e quantos estão só no bucket (para a tela Armazenamento). */
export async function fileLocations() {
  const r = await one<{ local_n: string; local_bytes: string; bucket_n: string; bucket_bytes: string; pending_n: string }>(`
    SELECT COUNT(*) FILTER (WHERE has_data) AS local_n, COALESCE(SUM(size) FILTER (WHERE has_data), 0) AS local_bytes,
           COUNT(*) FILTER (WHERE NOT has_data AND has_key) AS bucket_n, COALESCE(SUM(size) FILTER (WHERE NOT has_data AND has_key), 0) AS bucket_bytes,
           COUNT(*) FILTER (WHERE has_data AND NOT has_key) AS pending_n
      FROM (SELECT size, data IS NOT NULL AS has_data, storage_key IS NOT NULL AS has_key FROM documents
            UNION ALL SELECT size, data IS NOT NULL, storage_key IS NOT NULL FROM media_files) f`);
  return {
    local: { files: Number(r?.local_n ?? 0), bytes: Number(r?.local_bytes ?? 0) },
    bucketOnly: { files: Number(r?.bucket_n ?? 0), bytes: Number(r?.bucket_bytes ?? 0) },
    /** ainda sem cópia no bucket */
    pending: Number(r?.pending_n ?? 0),
  };
}

/** Conteúdo de uma linha de documents/media_files: no banco (data) ou no bucket (storage_key). */
export async function readBlob(row: { data?: Buffer | null; storage_key?: string | null }) {
  if (row.data) return row.data;
  if (row.storage_key) return getObject(row.storage_key);
  return Buffer.alloc(0);
}

/**
 * Objetos cuja linha sumiu (o gatilho da migração 030 anota, inclusive em cascata quando sai a execução ou a pessoa).
 * Sai do bucket aqui; o que falhar volta para a fila e tenta na próxima rodada.
 */
export async function purgeStorageTrash(limit = 200) {
  if (!(await storageOn())) return 0;
  const rows = await many<{ key: string }>(
    "DELETE FROM storage_trash WHERE key IN (SELECT key FROM storage_trash ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING key",
    [limit],
  );
  let n = 0;
  for (const r of rows) {
    try {
      await deleteObject(r.key);
      n++;
    } catch {
      await query("INSERT INTO storage_trash (key) VALUES ($1) ON CONFLICT DO NOTHING", [r.key]);
    }
  }
  return n;
}

/**
 * Migração gradual: leva até `limit` arquivos do bytea para o bucket por rodada (um por vez, sem carregar tudo na memória).
 * Com cópia na VM o bytea fica; sem, sai do banco (inclusive dos que já estavam nos dois lugares).
 */
export async function moveBlobsToStorage(limit = 50) {
  if (!(await storageOn())) return 0;
  const local = await keepLocalCopy();
  if (!local) {
    for (const t of ["documents", "media_files"]) {
      await query(
        `UPDATE ${t} SET data = NULL WHERE id IN (SELECT id FROM ${t} WHERE storage_key IS NOT NULL AND data IS NOT NULL LIMIT $1)`,
        [limit * 10],
      );
    }
  }
  const pending = await many<{ t: "documents" | "media_files"; id: string; user_id: string | null }>(
    `(SELECT 'documents' AS t, id, user_id FROM documents WHERE storage_key IS NULL AND data IS NOT NULL ORDER BY created_at LIMIT $1)
     UNION ALL
     (SELECT 'media_files' AS t, id, user_id FROM media_files WHERE storage_key IS NULL AND data IS NOT NULL ORDER BY created_at LIMIT $1)`,
    [limit],
  );
  let moved = 0;
  for (const p of pending.slice(0, limit)) {
    const row = await one<{ data: Buffer | null; mimetype: string }>(`SELECT data, mimetype FROM ${p.t} WHERE id = $1 AND storage_key IS NULL`, [p.id]);
    if (!row?.data) continue;
    const key = p.t === "documents" ? docKey(p.user_id!, p.id) : mediaKey(p.id);
    await putObject(key, row.data, row.mimetype);
    const r = await query(`UPDATE ${p.t} SET storage_key = $2${local ? "" : ", data = NULL"} WHERE id = $1 AND storage_key IS NULL`, [p.id, key]);
    // a linha sumiu no meio do caminho: o objeto não tem dono
    if (!r.rowCount) await deleteObject(key).catch(() => {});
    else moved++;
  }
  return moved;
}

/** Chave antiga (documents/, media/) de um objeto que já está no formato novo, ou null. */
function legacyKey(key: string) {
  if (key.startsWith("arquivos/documentos/")) return `documents/${key.slice("arquivos/documentos/".length)}`;
  if (key.startsWith("arquivos/midia/")) return `media/${key.slice("arquivos/midia/".length)}`;
  return null;
}

const notFound = (err: unknown) => /\b404\b|NoSuchKey/.test((err as Error).message ?? "");

/**
 * Caminho contrário, para desconectar o bucket: baixa para o banco (bytea) até `limit` arquivos que estavam só no bucket
 * (documentos, mídias e fotos da rede). Procura também no caminho antigo (documents/, media/).
 * `gone` = o objeto não existe no bucket (nem no caminho antigo): não tem o que trazer, então não segura a desconexão.
 * `failed` = erro de rede/permissão: esse sim segura. A storage_key fica na linha (se reconectar, o arquivo já está lá).
 */
export async function pullBlobsFromStorage(limit = 50, skip: string[] = []) {
  const rows = await many<{ t: "documents" | "media_files" | "feed_media"; id: string; storage_key: string }>(
    `(SELECT 'documents' AS t, id, storage_key FROM documents WHERE data IS NULL AND storage_key IS NOT NULL AND NOT (id::text = ANY($2)) ORDER BY created_at LIMIT $1)
     UNION ALL
     (SELECT 'media_files' AS t, id, storage_key FROM media_files WHERE data IS NULL AND storage_key IS NOT NULL AND NOT (id::text = ANY($2)) ORDER BY created_at LIMIT $1)
     UNION ALL
     (SELECT 'feed_media' AS t, id, storage_key FROM feed_media WHERE data IS NULL AND storage_key IS NOT NULL AND NOT (id::text = ANY($2)) ORDER BY created_at LIMIT $1)`,
    [limit, skip],
  );
  let pulled = 0;
  const gone: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const r of rows.slice(0, limit)) {
    let data: Buffer | null = null;
    let missing = false;
    for (const key of [r.storage_key, relocatedKey(r.storage_key) ?? legacyKey(r.storage_key)].filter(Boolean) as string[]) {
      try {
        data = await getObject(key);
        break;
      } catch (err) {
        if (notFound(err)) missing = true;
        else {
          failed.push({ id: String(r.id), error: (err as Error).message });
          missing = false;
          break;
        }
      }
    }
    if (data) {
      const u = await query(`UPDATE ${r.t} SET data = $3 WHERE id = $1 AND storage_key = $2 AND data IS NULL`, [r.id, r.storage_key, data]);
      if (u.rowCount) pulled++;
    } else if (missing) gone.push(String(r.id));
  }
  return { pulled, gone, failed, more: rows.length > 0 };
}

/** Chave nova (pastas arquivos/...) para um objeto gravado no formato antigo, ou null se já está no lugar. */
export function relocatedKey(key: string) {
  if (key.startsWith("documents/")) return `arquivos/documentos/${key.slice("documents/".length)}`;
  if (key.startsWith("media/")) return `arquivos/midia/${key.slice("media/".length)}`;
  return null;
}

/**
 * Arruma o bucket nas pastas novas sem parar nada: copia o objeto antigo para arquivos/..., troca a chave
 * na linha e só então apaga o antigo. Se a linha sumiu no meio, apaga a cópia (o antigo já foi pra lixeira).
 */
export async function relocateLegacyObjects(limit = 100) {
  if (!(await storageOn())) return 0;
  const rows = await many<{ t: "documents" | "media_files"; id: string; storage_key: string }>(
    `(SELECT 'documents' AS t, id, storage_key FROM documents WHERE storage_key LIKE 'documents/%' LIMIT $1)
     UNION ALL
     (SELECT 'media_files' AS t, id, storage_key FROM media_files WHERE storage_key LIKE 'media/%' LIMIT $1)`,
    [limit],
  );
  let moved = 0;
  for (const r of rows.slice(0, limit)) {
    const to = relocatedKey(r.storage_key);
    if (!to) continue;
    await copyObject(r.storage_key, to);
    const u = await query(`UPDATE ${r.t} SET storage_key = $3 WHERE id = $1 AND storage_key = $2`, [r.id, r.storage_key, to]);
    if (!u.rowCount) {
      await deleteObject(to).catch(() => {});
      continue;
    }
    await deleteObject(r.storage_key).catch(() => query("INSERT INTO storage_trash (key) VALUES ($1) ON CONFLICT DO NOTHING", [r.storage_key]));
    moved++;
  }
  return moved;
}
