import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { config } from "./config.js";
import { decryptWithExtra, encryptJson, keyFingerprint } from "./crypto.js";
import { migrate } from "./db/migrate.js";
import { many, one, pool, query } from "./db/pool.js";
import {
  bucketParts,
  copyObject,
  DB_FOLDER,
  deleteObject,
  fileSha256,
  getObject,
  getObjectToFile,
  headObject,
  KEYS_FOLDER,
  listObjects,
  putObject,
  putObjectFile,
  storageEnabled,
  type StoredObject,
} from "./storage.js";
import { VERSION } from "./version.js";

/**
 * Backup e migração (tela Servidor > Backup, só o dono da stack).
 * Tudo que é preciso para subir o Planejai de novo em outra VPS fica no bucket (Backblaze B2 ou outro S3):
 *   banco/      pg_dump diário (formato custom) + ficha .json de cada um. O dump tem TODO o Postgres:
 *               pessoas, agenda, finanças, memórias, integrações (cifradas), configurações, filas e a sessão do WhatsApp (wa_auth)
 *   arquivos/   documentos e mídias (o app já grava lá; o backup confere se cada linha do banco tem o objeto)
 *   chaves/     cofre com as variáveis da stack (ENCRYPTION_KEY etc.), cifrado com uma senha que só o dono sabe
 * Restaurar: baixa o dump, restaura num banco ao lado, atualiza (migrações), regrava as credenciais com a chave
 * desta stack se a antiga for outra, e só então troca os nomes dos bancos. O banco de antes fica guardado.
 */

export const KEEP_DAYS = 30;
const KEEP_MIN = 7;
const VAULT_KEY = `${KEYS_FOLDER}cofre-das-chaves.json`;
const README_KEY = "LEIA-ME.txt";
const LOCK_ID = 727275;

// ================= Comandos do Postgres =================

/** Variáveis PG* a partir do DATABASE_URL (a senha vai por env, não aparece na lista de processos). */
export function pgEnv(dbName?: string) {
  const u = new URL(config.DATABASE_URL);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PGHOST: decodeURIComponent(u.hostname),
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: dbName ?? decodeURIComponent(u.pathname.replace(/^\//, "")),
  };
  const ssl = u.searchParams.get("sslmode");
  if (ssl) env.PGSSLMODE = ssl;
  return env;
}

export const currentDbName = () => decodeURIComponent(new URL(config.DATABASE_URL).pathname.replace(/^\//, "")) || "postgres";

function urlFor(dbName: string) {
  const u = new URL(config.DATABASE_URL);
  u.pathname = `/${encodeURIComponent(dbName)}`;
  return u.toString();
}

function run(cmd: string, args: string[], env: Record<string, string>, timeoutMs = 60 * 60_000) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout = (stdout + d).slice(-2_000_000)));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-200_000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject((err as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`${cmd} não está instalado nesta imagem`) : err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

let toolsCache: { pgDump: string | null; pgRestore: string | null } | null = null;
export async function pgTools() {
  if (toolsCache) return toolsCache;
  const v = async (cmd: string) => (await run(cmd, ["--version"], pgEnv(), 10_000).catch(() => null))?.stdout.trim() || null;
  toolsCache = { pgDump: await v("pg_dump"), pgRestore: await v("pg_restore") };
  return toolsCache;
}

const ident = (name: string) => {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error(`Nome de banco inesperado: ${name}`);
  return `"${name}"`;
};

const stamp = (d = new Date()) => d.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");

// ================= O que existe hoje =================

const INVENTORY: { table: string; label: string }[] = [
  { table: "users", label: "Pessoas (WhatsApp)" },
  { table: "accounts", label: "Contas do painel" },
  { table: "reminders", label: "Agenda e lembretes" },
  { table: "transactions", label: "Lançamentos de finanças" },
  { table: "bills", label: "Contas fixas" },
  { table: "memories", label: "Memórias" },
  { table: "documents", label: "Documentos" },
  { table: "media_files", label: "Mídias" },
  { table: "user_integrations", label: "Contas conectadas dos clientes" },
  { table: "wa_auth", label: "Chaves da sessão do WhatsApp" },
];

/** Quantas linhas tem em cada tabela importante (as que não existem nesta versão ficam de fora). */
export async function inventory(client: { query: pg.Pool["query"] } = pool) {
  const out: { table: string; label: string; rows: number }[] = [];
  for (const t of INVENTORY) {
    const exists = (await client.query("SELECT to_regclass($1) AS r", [`public.${t.table}`])).rows[0]?.r;
    if (!exists) continue;
    const r = await client.query(`SELECT COUNT(*)::bigint AS n FROM ${t.table}`);
    out.push({ ...t, rows: Number(r.rows[0]?.n ?? 0) });
  }
  return out;
}

/** Instalação nova: ninguém cadastrado ainda (é quando faz sentido restaurar sem medo). */
export async function isFreshInstall() {
  const r = await one<{ n: string }>("SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM accounts) AS n");
  return Number(r?.n ?? 0) === 0;
}

/**
 * Confere os arquivos: cada documento/mídia do banco tem que estar no bucket (ou dentro do dump, se está no banco).
 * `missing` = linha que aponta para o bucket mas o objeto não está lá.
 */
export async function checkFiles() {
  const rows = await many<{ storage_key: string | null; has_data: boolean; size: number }>(
    `SELECT storage_key, data IS NOT NULL AS has_data, size FROM documents
     UNION ALL SELECT storage_key, data IS NOT NULL, size FROM media_files`,
  );
  const inDbOnly = rows.filter((r) => r.has_data && !r.storage_key);
  const inBucket = rows.filter((r) => r.storage_key);
  let missing = 0;
  let listed: StoredObject[] = [];
  let truncated = false;
  if (storageEnabled() && inBucket.length) {
    const folders = ["arquivos/", ...(inBucket.some((r) => !r.storage_key!.startsWith("arquivos/")) ? ["documents/", "media/"] : [])];
    for (const f of folders) {
      const l = await listObjects(f);
      listed = listed.concat(l.objects);
      truncated ||= l.truncated;
    }
    const keys = new Set(listed.map((o) => o.key));
    if (!truncated) missing = inBucket.filter((r) => !keys.has(r.storage_key!)).length;
  }
  return {
    total: rows.length,
    inBucket: inBucket.length,
    inBucketBytes: inBucket.reduce((a, r) => a + Number(r.size ?? 0), 0),
    inDbOnly: inDbOnly.length,
    inDbOnlyBytes: inDbOnly.reduce((a, r) => a + Number(r.size ?? 0), 0),
    missing,
    /** objetos no bucket (inclui os que já não têm linha: lixeira ainda não passou) */
    objects: listed.length,
    objectsBytes: listed.reduce((a, o) => a + o.size, 0),
    truncated,
  };
}

async function lastMigration(client: { query: pg.Pool["query"] } = pool) {
  const r = await client.query("SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1").catch(() => null);
  return (r?.rows[0]?.name as string | undefined) ?? null;
}

// ================= Backup =================

export interface BackupManifest {
  file: string;
  created_at: string;
  reason: string;
  bytes: number;
  sha256: string;
  app_version: string;
  last_migration: string | null;
  pg_dump: string | null;
  /** impressão digital da ENCRYPTION_KEY que cifrou as credenciais deste dump */
  key_fingerprint: string | null;
  inventory: { table: string; label: string; rows: number }[];
  files: Awaited<ReturnType<typeof checkFiles>>;
  verified?: { downloaded: boolean; entries: number } | null;
}

/** Arquivos que o app reconhece como dump em banco/ (os do serviço "backup" da stack também). */
const DUMP_RE = /^(?:banco|backups)\/((?:planejai|antes-de-restaurar)-\d{8}-\d{4}\.dump)$/;

const README = `PLANEJAI: O QUE TEM NESTE BUCKET
================================

banco/                      Backup do banco (pg_dump, formato custom), um por dia, ${KEEP_DAYS} dias.
                            Cada .dump tem uma ficha .json do lado (data, versão, quantas pessoas etc.).
                            O dump tem TUDO do Postgres: pessoas, agenda, finanças, memórias,
                            integrações (cifradas), configurações e a sessão do WhatsApp.
arquivos/documentos/<id>/   Documentos de cada pessoa (o <id> é o da pessoa no banco).
arquivos/midia/             Fotos, áudios e gravações que o time guardou.
chaves/                     Cofre com as variáveis da stack (ENCRYPTION_KEY etc.), cifrado com a
                            senha que o dono escolheu no painel. Sem essa senha ninguém abre.

Para subir em outra VPS: painel > Servidor > Backup > "Como migrar".
Não apague nem renomeie nada aqui na mão: o banco guarda o caminho de cada arquivo.
`;

let current: Promise<unknown> | null = null;

/**
 * Faz o dump, sobe para banco/ com a ficha, confere o tamanho no bucket e arruma o resto.
 * `verify`: baixa de volta e confere o hash e se o pg_restore lê o arquivo (botão "Testar backup agora").
 */
export async function runBackup(reason: "agenda" | "manual" | "teste" | "antes-de-restaurar", opts: { verify?: boolean; log?: (m: string) => void } = {}) {
  if (!storageEnabled()) throw new Error("Bucket não configurado (STORAGE_S3_*): o backup só vai para fora com ele.");
  const lock = await pool.connect();
  const got = (await lock.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_ID])).rows[0]?.ok;
  if (!got) {
    lock.release();
    throw new Error("Já tem um backup rodando. Espere ele terminar.");
  }
  const runRow = await one<{ id: string }>("INSERT INTO backup_runs (reason) VALUES ($1) RETURNING id", [reason]);
  const dir = await mkdtemp(join(tmpdir(), "planejai-backup-"));
  try {
    const name = `${reason === "antes-de-restaurar" ? "antes-de-restaurar" : "planejai"}-${stamp()}.dump`;
    const file = join(dir, name);
    const dump = await run("pg_dump", ["-Fc", "-f", file], pgEnv());
    if (dump.code !== 0) throw new Error(`pg_dump falhou: ${dump.stderr.trim().split("\n").slice(-3).join(" ")}`);
    const { size } = await stat(file);
    const hash = await fileSha256(file);
    const files = await checkFiles();
    const manifest: BackupManifest = {
      file: name,
      created_at: new Date().toISOString(),
      reason,
      bytes: size,
      sha256: hash,
      app_version: VERSION,
      last_migration: await lastMigration(),
      pg_dump: (await pgTools()).pgDump,
      key_fingerprint: keyFingerprint(),
      inventory: await inventory(),
      files,
    };
    const key = `${DB_FOLDER}${name}`;
    await putObjectFile(key, file, "application/octet-stream", hash);
    const head = await headObject(key);
    if (!head || head.size !== size) throw new Error(`O bucket guardou ${head?.size ?? 0} bytes de ${size}: o envio não fechou.`);
    if (opts.verify) {
      const back = join(dir, "conferencia.dump");
      await getObjectToFile(key, back);
      if ((await fileSha256(back)) !== hash) throw new Error("O arquivo que voltou do bucket não bate com o enviado.");
      const list = await run("pg_restore", ["-l", back], pgEnv());
      if (list.code !== 0) throw new Error(`pg_restore não leu o backup: ${list.stderr.trim().slice(-200)}`);
      manifest.verified = { downloaded: true, entries: list.stdout.split("\n").filter((l) => /^\d+;/.test(l)).length };
    }
    await putObject(`${key}.json`, Buffer.from(JSON.stringify(manifest, null, 2)), "application/json");
    await putObject(README_KEY, Buffer.from(README), "text/plain; charset=utf-8").catch(() => {});
    await tidyDumps(opts.log).catch((err) => opts.log?.(`arrumação dos backups antigos falhou: ${(err as Error).message}`));
    await query("UPDATE backup_runs SET finished_at = now(), ok = true, key = $2, bytes = $3, manifest = $4 WHERE id = $1", [runRow!.id, key, size, manifest]);
    opts.log?.(`backup ok: ${key} (${size} bytes)`);
    return { id: runRow!.id, key, manifest };
  } catch (err) {
    await query("UPDATE backup_runs SET finished_at = now(), ok = false, error = $2 WHERE id = $1", [runRow!.id, (err as Error).message.slice(0, 500)]);
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await lock.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    lock.release();
  }
}

/** Dispara sem esperar (botões do painel): o andamento aparece na lista de rodadas. */
export function startBackup(reason: "manual" | "teste", log?: (m: string) => void) {
  if (current) throw new Error("Já tem um backup rodando. Espere ele terminar.");
  current = runBackup(reason, { verify: reason === "teste", log })
    .catch((err) => log?.(`backup falhou: ${(err as Error).message}`))
    .finally(() => (current = null));
}

/**
 * Pasta banco/ em ordem: o que o serviço "backup" da stack deixou em backups/ vem para banco/,
 * e dump com mais de KEEP_DAYS dias sai (sempre ficam os KEEP_MIN mais novos).
 */
async function tidyDumps(log?: (m: string) => void) {
  const legacy = (await listObjects("backups/")).objects.filter((o) => DUMP_RE.test(o.key));
  for (const o of legacy) {
    const to = `${DB_FOLDER}${o.key.slice("backups/".length)}`;
    await copyObject(o.key, to);
    await deleteObject(o.key);
    log?.(`backup antigo movido para ${to}`);
  }
  const dumps = (await listObjects(DB_FOLDER)).objects.filter((o) => DUMP_RE.test(o.key)).sort((a, b) => b.key.localeCompare(a.key));
  const limit = Date.now() - KEEP_DAYS * 86_400_000;
  for (const o of dumps.slice(KEEP_MIN)) {
    if (new Date(o.lastModified).getTime() >= limit) continue;
    await deleteObject(o.key);
    await deleteObject(`${o.key}.json`).catch(() => {});
  }
}

/** Dumps que estão no bucket (mais novo primeiro), com a ficha dos `withManifest` primeiros. */
export async function remoteDumps(withManifest = 5) {
  const all = [...(await listObjects(DB_FOLDER)).objects, ...(await listObjects("backups/")).objects];
  const dumps = all.filter((o) => DUMP_RE.test(o.key)).sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  return Promise.all(
    dumps.map(async (o, i) => {
      let manifest: BackupManifest | null = null;
      if (i < withManifest) manifest = await getObject(`${o.key}.json`).then((b) => JSON.parse(b.toString("utf8")) as BackupManifest).catch(() => null);
      return { ...o, manifest };
    }),
  );
}

// ================= Cofre das chaves =================

const scrypt = (pass: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(pass, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, k) => (err ? reject(err) : resolve(k))));

/** Variáveis da stack que este processo recebeu (o que precisa para montar a stack igual em outro lugar). */
export function stackEnv() {
  const env: Record<string, string> = {};
  for (const k of Object.keys(config)) {
    const v = process.env[k];
    if (v && k !== "ROLE") env[k] = v;
  }
  // as chaves que abrem os dados valem como o processo as leu (sempre entram, mesmo vindas de outro jeito)
  for (const k of ["ENCRYPTION_KEY", "ENCRYPTION_KEY_OLD", "APP_SECRET", "SESSION_SECRET"] as const) {
    if (config[k]) env[k] = config[k];
  }
  const pw = decodeURIComponent(new URL(config.DATABASE_URL).password);
  if (pw) env.POSTGRES_PASSWORD = pw;
  return env;
}

export async function saveVault(passphrase: string) {
  if (passphrase.length < 10) throw new Error("Use uma senha de pelo menos 10 caracteres.");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await scrypt(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(stackEnv()), "utf8"), cipher.final()]);
  const vault = {
    v: 1,
    created_at: new Date().toISOString(),
    kdf: "scrypt-N32768-r8-p1",
    key_fingerprint: keyFingerprint(),
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  await putObject(VAULT_KEY, Buffer.from(JSON.stringify(vault, null, 2)), "application/json");
  return { savedAt: vault.created_at, keyFingerprint: vault.key_fingerprint };
}

export async function vaultInfo() {
  const raw = await getObject(VAULT_KEY).catch(() => null);
  if (!raw) return null;
  const v = JSON.parse(raw.toString("utf8"));
  return { savedAt: v.created_at as string, keyFingerprint: (v.key_fingerprint as string | null) ?? null };
}

export async function openVault(passphrase: string): Promise<Record<string, string>> {
  const raw = await getObject(VAULT_KEY).catch(() => null);
  if (!raw) throw new Error("Não tem cofre no bucket ainda.");
  const v = JSON.parse(raw.toString("utf8"));
  const key = await scrypt(passphrase, Buffer.from(v.salt, "base64"));
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(v.iv, "base64"));
    d.setAuthTag(Buffer.from(v.tag, "base64"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(v.data, "base64")), d.final()]).toString("utf8"));
  } catch {
    throw new Error("Senha do cofre errada.");
  }
}

// ================= Restaurar =================

/** Colunas cifradas com a ENCRYPTION_KEY (ver crypto.ts). Na restauração todas são regravadas com a chave desta stack. */
const ENCRYPTED: { table: string; select: string; update: string }[] = [
  { table: "integrations", select: "SELECT ctid::text AS id, credentials_enc AS v FROM integrations WHERE credentials_enc IS NOT NULL", update: "UPDATE integrations SET credentials_enc = $2 WHERE ctid = $1::tid" },
  { table: "user_integrations", select: "SELECT ctid::text AS id, credentials_enc AS v FROM user_integrations WHERE credentials_enc IS NOT NULL", update: "UPDATE user_integrations SET credentials_enc = $2 WHERE ctid = $1::tid" },
  { table: "subscriptions", select: "SELECT ctid::text AS id, saved_card_token AS v FROM subscriptions WHERE saved_card_token IS NOT NULL", update: "UPDATE subscriptions SET saved_card_token = $2 WHERE ctid = $1::tid" },
  { table: "settings", select: "SELECT key AS id, value #>> '{}' AS v FROM settings WHERE key = 'vapid_keys' AND jsonb_typeof(value) = 'string'", update: "UPDATE settings SET value = to_jsonb($2::text) WHERE key = $1" },
];

/** Regrava com a chave atual o que só abre com uma chave antiga. `failed` = não abriu com nenhuma. */
export async function reencryptAll(client: pg.ClientBase, extraSecrets: string[], dryRun = false) {
  let total = 0;
  let fixed = 0;
  let failed = 0;
  for (const spec of ENCRYPTED) {
    const exists = (await client.query("SELECT to_regclass($1) AS r", [`public.${spec.table}`])).rows[0]?.r;
    if (!exists) continue;
    for (const row of (await client.query(spec.select)).rows as { id: string; v: string }[]) {
      total++;
      const r = decryptWithExtra(row.v, extraSecrets);
      if (!r) {
        failed++;
        continue;
      }
      if (!r.stale) continue;
      if (!dryRun) await client.query(spec.update, [row.id, encryptJson(r.value)]);
      fixed++;
    }
  }
  return { total, fixed, failed };
}

export type RestorePhase = "baixando" | "conferindo" | "copia" | "restaurando" | "atualizando" | "chaves" | "trocando" | "pronto" | "erro";
export interface RestoreState {
  phase: RestorePhase;
  key: string;
  startedAt: string;
  finishedAt?: string;
  message: string;
  error?: string;
  /** banco de antes, guardado ao lado (nome) */
  previousDb?: string;
  credentials?: { total: number; fixed: number; failed: number };
}

let restoreState: RestoreState | null = null;
export const restoreStatus = () => restoreState;

export interface RestoreInput {
  key: string;
  /** chave antiga (ENCRYPTION_KEY da stack de onde veio o backup) ou a senha do cofre */
  secret?: string;
  /** restaurar mesmo sem conseguir abrir as credenciais (aí é preciso conectar as integrações de novo) */
  ignoreKeys?: boolean;
}

/** Erros do pg_restore que não estragam nada (cliente mais novo que o servidor, comentário de extensão). */
const HARMLESS = /transaction_timeout|must be owner of extension|COMMENT ON EXTENSION|schema "public" already exists/i;

export function startRestore(input: RestoreInput, log: (m: string) => void, onDone: () => void) {
  if (restoreState && !["pronto", "erro"].includes(restoreState.phase)) throw new Error("Já tem uma restauração em andamento.");
  if (!DUMP_RE.test(input.key)) throw new Error("Escolha um backup da pasta banco/.");
  restoreState = { phase: "baixando", key: input.key, startedAt: new Date().toISOString(), message: "Baixando o backup do bucket" };
  void doRestore(input, log)
    .then(() => onDone())
    .catch((err) => {
      log(`restauração falhou: ${(err as Error).message}`);
      restoreState = { ...restoreState!, phase: "erro", finishedAt: new Date().toISOString(), error: (err as Error).message, message: "Nada mudou: o banco atual continua igual." };
    });
}

const step = (phase: RestorePhase, message: string) => (restoreState = { ...restoreState!, phase, message });

async function doRestore(input: RestoreInput, log: (m: string) => void) {
  if (!storageEnabled()) throw new Error("Bucket não configurado (STORAGE_S3_*).");
  const tools = await pgTools();
  if (!tools.pgRestore) throw new Error("pg_restore não está instalado nesta imagem. Atualize para a versão nova do Planejai.");
  const dir = await mkdtemp(join(tmpdir(), "planejai-restore-"));
  const cur = currentDbName();
  const tmpDb = `${cur}_restaurando`;
  const admin = new pg.Client({ connectionString: urlFor("postgres") });
  let target: pg.Pool | null = null;
  try {
    // 1. baixa e confere
    const file = join(dir, "restore.dump");
    await getObjectToFile(input.key, file);
    step("conferindo", "Conferindo o arquivo");
    const manifest = await getObject(`${input.key}.json`).then((b) => JSON.parse(b.toString("utf8")) as BackupManifest).catch(() => null);
    if (manifest && (await fileSha256(file)) !== manifest.sha256) throw new Error("O arquivo baixado não bate com a ficha do backup (sha256). Tente outro backup.");
    const list = await run("pg_restore", ["-l", file], pgEnv());
    if (list.code !== 0) throw new Error(`O arquivo não é um backup válido: ${list.stderr.trim().slice(-200)}`);

    // 2. chaves: a antiga direto ou as do cofre
    let extra: string[] = [];
    if (input.secret) {
      const vault = await openVault(input.secret).catch(() => null);
      extra = vault ? [vault.ENCRYPTION_KEY, vault.ENCRYPTION_KEY_OLD, vault.APP_SECRET].filter((s): s is string => Boolean(s)) : [input.secret.trim()];
    }

    // 3. cópia do que existe hoje, se tem alguém cadastrado
    if (!(await isFreshInstall())) {
      step("copia", "Guardando uma cópia do banco atual no bucket antes de trocar");
      await runBackup("antes-de-restaurar", { log });
    }

    // 4. restaura num banco ao lado: o atual segue funcionando até a troca
    step("restaurando", "Restaurando num banco separado (o atual continua no ar)");
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${ident(tmpDb)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${ident(tmpDb)} TEMPLATE template0 ENCODING 'UTF8'`);
    const res = await run("pg_restore", ["--no-owner", "--no-privileges", "-d", tmpDb, file], pgEnv(tmpDb));
    const errors = res.stderr.split("\n").filter((l) => /error:/i.test(l) && !HARMLESS.test(l));
    if (res.code !== 0 && errors.length) throw new Error(`pg_restore: ${errors.slice(0, 3).join(" | ").slice(0, 400)}`);

    // 5. atualiza o banco restaurado para esta versão e confere as credenciais
    step("atualizando", "Atualizando o banco restaurado para esta versão");
    target = new pg.Pool({ connectionString: urlFor(tmpDb), max: 2 });
    target.on("error", () => {});
    await migrate(log, target);
    step("chaves", "Conferindo as credenciais cifradas");
    const c = await target.connect();
    try {
      const check = await reencryptAll(c, extra, true);
      if (check.failed && !input.ignoreKeys) {
        throw new Error(
          `${check.failed} de ${check.total} credenciais deste backup foram cifradas com outra ENCRYPTION_KEY. Informe a chave antiga ou a senha do cofre (ou marque para restaurar assim mesmo e conectar as integrações de novo).`,
        );
      }
      restoreState!.credentials = await reencryptAll(c, extra);
      await c.query(
        "INSERT INTO settings (key, value) VALUES ('restoredAt', to_jsonb($1::text)) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        [JSON.stringify({ at: new Date().toISOString(), from: input.key })],
      );
    } finally {
      c.release();
    }
    await target.end();
    target = null;

    // 6. troca: o atual vira <nome>_antes_<data>, o restaurado assume o nome
    step("trocando", "Trocando o banco (alguns segundos fora do ar)");
    const previous = `${cur}_antes_${stamp().replace("-", "_")}`;
    await admin.query(`ALTER DATABASE ${ident(cur)} WITH ALLOW_CONNECTIONS false`);
    try {
      for (let i = 0; i < 20; i++) {
        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [cur]);
        const left = (await admin.query("SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = $1", [cur])).rows[0]?.n;
        if (!left) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      await admin.query(`ALTER DATABASE ${ident(cur)} RENAME TO ${ident(previous)}`);
    } catch (err) {
      await admin.query(`ALTER DATABASE ${ident(cur)} WITH ALLOW_CONNECTIONS true`).catch(() => {});
      throw err;
    }
    await admin.query(`ALTER DATABASE ${ident(tmpDb)} RENAME TO ${ident(cur)}`);
    await admin.query(`ALTER DATABASE ${ident(previous)} WITH ALLOW_CONNECTIONS true`).catch(() => {});
    // só o banco de antes desta restauração fica guardado
    const olds = await admin.query("SELECT datname FROM pg_database WHERE datname LIKE $1 AND datname <> $2", [`${cur}\\_antes\\_%`, previous]);
    for (const o of olds.rows) await admin.query(`DROP DATABASE IF EXISTS ${ident(o.datname)} WITH (FORCE)`).catch(() => {});
    restoreState = { ...restoreState!, phase: "pronto", finishedAt: new Date().toISOString(), previousDb: previous, message: "Restaurado. O Planejai reinicia sozinho em alguns segundos: entre de novo." };
    log(`restauração pronta: ${input.key}; banco anterior guardado como ${previous}`);
  } catch (err) {
    await target?.end().catch(() => {});
    target = null;
    await admin.query(`DROP DATABASE IF EXISTS ${ident(tmpDb)} WITH (FORCE)`).catch(() => {});
    throw err;
  } finally {
    await target?.end().catch(() => {});
    await admin.end().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Marca de restauração no banco: o worker reinicia quando ela muda (para ler a sessão do WhatsApp restaurada). */
export async function restoredMark() {
  return (await one<{ v: string }>("SELECT value::text AS v FROM settings WHERE key = 'restoredAt'").catch(() => null))?.v ?? null;
}

export function watchRestore(onRestored: () => void) {
  let boot: string | null | undefined;
  void restoredMark().then((v) => (boot = v));
  setInterval(() => {
    void restoredMark().then((v) => {
      if (boot === undefined) return;
      if (v !== boot) onRestored();
    });
  }, 20_000).unref();
}

export const bucketLabel = () => {
  if (!storageEnabled()) return null;
  const { bucket, prefix } = bucketParts();
  return { host: new URL(config.STORAGE_S3_ENDPOINT).host, endpoint: config.STORAGE_S3_ENDPOINT, region: config.STORAGE_S3_REGION, bucket, prefix };
};
