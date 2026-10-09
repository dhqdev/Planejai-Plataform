import { createHash, createHmac } from "node:crypto";
import { config } from "./config.js";
import { many, one, query } from "./db/pool.js";

/**
 * Arquivos fora do Postgres: storage S3 compatível (Cloudflare R2, S3, B2) configurado pelo dono.
 * Assinatura AWS SigV4 feita aqui (sem SDK). Sem as envs STORAGE_S3_*, documentos e mídias ficam no banco (bytea).
 * O endpoint é env do dono (não vem de usuário/modelo), então fetch direto com timeout.
 */
const TIMEOUT_MS = 30_000;

export function storageEnabled() {
  return Boolean(config.STORAGE_S3_ENDPOINT && config.STORAGE_S3_BUCKET && config.STORAGE_S3_ACCESS_KEY_ID && config.STORAGE_S3_SECRET_ACCESS_KEY);
}

export const docKey = (userId: string, id: string) => `documents/${userId}/${id}`;
export const mediaKey = (id: string) => `media/${id}`;

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
// RFC 3986, como a AWS pede no caminho (a "/" entre partes fica)
const encodeKey = (key: string) =>
  key
    .split("/")
    .map((p) => encodeURIComponent(p).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");

/** Monta a requisição assinada (path-style: <endpoint>/<bucket>/<chave>). Exportada para o teste conferir a assinatura. */
export function signRequest(method: string, key: string, body: Buffer | null, opts: { contentType?: string; now?: Date } = {}) {
  const base = new URL(config.STORAGE_S3_ENDPOINT);
  const prefix = base.pathname.replace(/\/+$/, "");
  const url = new URL(`${base.origin}${prefix}/${encodeKey(config.STORAGE_S3_BUCKET)}/${encodeKey(key)}`);
  const amzDate = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const region = config.STORAGE_S3_REGION || "auto";
  const payloadHash = sha256(body ?? "");
  const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  if (opts.contentType) headers["content-type"] = opts.contentType;
  const names = Object.keys(headers).sort();
  const canonical = [method, url.pathname, "", ...names.map((n) => `${n}:${headers[n]!.trim()}`), "", names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  let k: Buffer = hmac(`AWS4${config.STORAGE_S3_SECRET_ACCESS_KEY}`, day);
  for (const part of [region, "s3", "aws4_request"]) k = hmac(k, part);
  const signature = createHmac("sha256", k).update(toSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.STORAGE_S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  delete headers.host;
  return { url: url.toString(), headers };
}

async function send(method: string, key: string, body: Buffer | null, contentType?: string) {
  if (!storageEnabled()) throw new Error("Storage de arquivos não configurado");
  const { url, headers } = signRequest(method, key, body, { contentType });
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
  if (!storageEnabled()) return 0;
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

/** Migração gradual: leva até `limit` arquivos do bytea para o bucket por rodada (um por vez, sem carregar tudo na memória). */
export async function moveBlobsToStorage(limit = 50) {
  if (!storageEnabled()) return 0;
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
    const r = await query(`UPDATE ${p.t} SET storage_key = $2, data = NULL WHERE id = $1 AND storage_key IS NULL`, [p.id, key]);
    // a linha sumiu no meio do caminho: o objeto não tem dono
    if (!r.rowCount) await deleteObject(key).catch(() => {});
    else moved++;
  }
  return moved;
}
