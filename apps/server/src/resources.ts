import { readFile, statfs } from "node:fs/promises";
import os from "node:os";
import type { Redis } from "ioredis";
import { config } from "./config.js";
import { many, one, query } from "./db/pool.js";
import { getCredentials } from "./integrations/registry.js";
import { redisHandles } from "./shortmem.js";
import { COMMIT, VERSION } from "./version.js";

/**
 * Tela Servidor (só super admin): memória e CPU dos processos do app, banco, Redis, navegador e disco,
 * e quanto cada cliente ocupa no armazenamento. Mostra tamanhos, nunca o conteúdo dos dados.
 *
 * App e worker rodam em contêineres separados: cada processo grava a própria foto no Redis a cada 15s
 * (pj:proc:<host>:<pid>, vence em 45s) e um histórico curto da última hora (pj:proc-hist:...), e a API junta tudo.
 */

const BEAT_MS = 15_000;
const HISTORY_POINTS = 240; // 1h com uma foto a cada 15s
const procKey = (id: string) => `pj:proc:${id}`;
const histKey = (id: string) => `pj:proc-hist:${id}`;

export interface ProcSample {
  id: string;
  role: string;
  host: string;
  pid: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  /** % de um núcleo na última janela */
  cpu: number;
  uptime: number;
  node: string;
  version: string;
  /** memória do contêiner (cgroup) e o limite dele; null quando não dá para ler */
  container: { used: number | null; limit: number | null };
  ts: number;
}

let lastCpu = process.cpuUsage();
let lastAt = process.hrtime.bigint();
let cpuPct = 0;

function measureCpu() {
  const now = process.hrtime.bigint();
  const used = process.cpuUsage(lastCpu);
  const elapsedUs = Number(now - lastAt) / 1000;
  if (elapsedUs > 0) cpuPct = Math.max(0, ((used.user + used.system) / elapsedUs) * 100);
  lastCpu = process.cpuUsage();
  lastAt = now;
}

async function readNumber(path: string): Promise<number | null> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    if (!raw || raw === "max") return null;
    const n = Number(raw);
    // cgroup v1 sem limite devolve um número absurdo (~9.2e18)
    return Number.isFinite(n) && n < 2 ** 60 ? n : null;
  } catch {
    return null;
  }
}

async function containerMemory() {
  const used = (await readNumber("/sys/fs/cgroup/memory.current")) ?? (await readNumber("/sys/fs/cgroup/memory/memory.usage_in_bytes"));
  const limit = (await readNumber("/sys/fs/cgroup/memory.max")) ?? (await readNumber("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
  return { used, limit };
}

const ROLE_OF = () => (config.ROLE === "all" ? "app" : config.ROLE);

export async function sampleSelf(): Promise<ProcSample> {
  const m = process.memoryUsage();
  return {
    id: `${os.hostname()}:${process.pid}`,
    role: ROLE_OF(),
    host: os.hostname(),
    pid: process.pid,
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
    cpu: Math.round(cpuPct * 10) / 10,
    uptime: Math.round(process.uptime()),
    node: process.version,
    version: COMMIT ? `${VERSION} (${COMMIT})` : VERSION,
    container: await containerMemory(),
    ts: Date.now(),
  };
}

/** Foto deste processo no Redis a cada 15s (API e worker), para a tela Servidor juntar os dois. */
export function startProcessBeat() {
  const beat = async () => {
    measureCpu();
    const r = redisHandles().main;
    if (!r) return;
    try {
      const s = await sampleSelf();
      await r
        .multi()
        .set(procKey(s.id), JSON.stringify(s), "EX", 45)
        .rpush(histKey(s.id), JSON.stringify([s.ts, s.rss, s.cpu]))
        .ltrim(histKey(s.id), -HISTORY_POINTS, -1)
        .expire(histKey(s.id), 7200)
        .exec();
    } catch {
      /* sem Redis a tela mostra só o processo da API */
    }
  };
  setTimeout(() => void beat(), 2000).unref();
  setInterval(() => void beat(), BEAT_MS).unref();
}

async function scanKeys(r: Redis, match: string, cap: number) {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await r.scan(cursor, "MATCH", match, "COUNT", 500);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0" && keys.length < cap);
  return { keys: keys.slice(0, cap), capped: cursor !== "0" };
}

async function processes() {
  const self = await sampleSelf();
  const r = redisHandles().main;
  const list: (ProcSample & { history: [number, number, number][] })[] = [];
  if (r) {
    try {
      const { keys } = await scanKeys(r, "pj:proc:*", 200);
      const raw = keys.length ? await r.mget(...keys) : [];
      for (const v of raw) {
        if (!v) continue;
        const s = JSON.parse(v) as ProcSample;
        if (Date.now() - s.ts > 60_000) continue; // processo que já saiu (redeploy)
        const hist = (await r.lrange(histKey(s.id), 0, -1)).map((h) => JSON.parse(h) as [number, number, number]);
        list.push(s.id === self.id ? { ...self, history: hist } : { ...s, history: hist });
      }
    } catch {
      /* segue só com este processo */
    }
  }
  if (!list.some((p) => p.id === self.id)) list.push({ ...self, history: [] });
  const order = (role: string) => (role === "api" ? 0 : role === "app" ? 1 : 2);
  return list.sort((a, b) => order(a.role) - order(b.role) || a.host.localeCompare(b.host));
}

async function disk() {
  try {
    const s = await statfs("/");
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, used: total - free, free };
  } catch {
    return null;
  }
}

function machine() {
  return {
    host: os.hostname(),
    platform: `${os.platform()} ${os.arch()}`,
    cpus: os.cpus().length,
    load: os.loadavg().map((n) => Math.round(n * 100) / 100),
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    uptime: Math.round(os.uptime()),
  };
}

async function postgres() {
  const info = await one(`
    SELECT pg_database_size(current_database())::bigint AS size,
           current_setting('server_version') AS version,
           current_setting('max_connections')::int AS max_connections,
           current_setting('shared_buffers') AS shared_buffers,
           (SELECT COUNT(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections,
           (SELECT COUNT(*)::int FROM pg_stat_activity WHERE datname = current_database() AND state = 'active') AS active,
           extract(epoch FROM now() - pg_postmaster_start_time())::bigint AS uptime,
           (SELECT CASE WHEN blks_hit + blks_read = 0 THEN NULL ELSE round(blks_hit * 100.0 / (blks_hit + blks_read), 2) END
              FROM pg_stat_database WHERE datname = current_database()) AS cache_hit`);
  // tabelas do app uma a uma; as de outros esquemas (pg-boss tem uma partição por fila) somadas numa linha
  const tables = await many(`
    SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname END AS name,
           SUM(pg_total_relation_size(c.oid))::bigint AS total,
           SUM(pg_relation_size(c.oid))::bigint AS data,
           SUM(pg_indexes_size(c.oid))::bigint AS indexes,
           SUM(GREATEST(COALESCE(s.n_live_tup, 0), c.reltuples, 0))::bigint AS rows
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
     WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
     GROUP BY 1 ORDER BY 2 DESC LIMIT 14`);
  return { ...info, tables: tables.map((t) => ({ ...t, label: TABLE_LABEL[t.name] ?? (t.name === "pgboss" ? "Filas (pg-boss)" : t.name) })) };
}

const REDIS_GROUPS: { prefix: string; label: string }[] = [
  { prefix: "pj:conv:", label: "Conversas recentes" },
  { prefix: "pj:cache:", label: "Cache de buscas e mídia" },
  { prefix: "pj:seen:", label: "Mensagens já vistas" },
  { prefix: "pj:rate:", label: "Ritmo e limites" },
  { prefix: "pj:proc", label: "Fotos dos processos" },
];

function parseInfo(raw: string) {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

async function redisStats(r: Redis | null, breakdown: boolean) {
  if (!r) return null;
  try {
    const info = parseInfo(await r.info());
    const hits = Number(info.keyspace_hits ?? 0);
    const misses = Number(info.keyspace_misses ?? 0);
    const out = {
      ok: true,
      version: info.redis_version,
      used: Number(info.used_memory ?? 0),
      rss: Number(info.used_memory_rss ?? 0),
      peak: Number(info.used_memory_peak ?? 0),
      max: Number(info.maxmemory ?? 0) || null,
      policy: info.maxmemory_policy ?? null,
      fragmentation: Number(info.mem_fragmentation_ratio ?? 0) || null,
      clients: Number(info.connected_clients ?? 0),
      uptime: Number(info.uptime_in_seconds ?? 0),
      keys: await r.dbsize(),
      hitRate: hits + misses ? Math.round((hits / (hits + misses)) * 1000) / 10 : null,
      groups: [] as { label: string; keys: number; bytes: number }[],
      sampled: false,
    };
    if (breakdown) {
      const { keys, capped } = await scanKeys(r, "*", 10_000);
      const sizes = await memoryUsage(r, keys);
      const groups = new Map<string, { label: string; keys: number; bytes: number }>();
      keys.forEach((k, i) => {
        const label = REDIS_GROUPS.find((g) => k.startsWith(g.prefix))?.label ?? (k.includes("boss") ? "Filas" : "Outros");
        const g = groups.get(label) ?? { label, keys: 0, bytes: 0 };
        g.keys++;
        g.bytes += sizes[i] ?? 0;
        groups.set(label, g);
      });
      out.groups = [...groups.values()].sort((a, b) => b.bytes - a.bytes);
      out.sampled = capped;
    }
    return out;
  } catch {
    return { ok: false };
  }
}

async function memoryUsage(r: Redis, keys: string[]): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < keys.length; i += 500) {
    const pipe = r.pipeline();
    for (const k of keys.slice(i, i + 500)) pipe.memory("USAGE", k);
    const res = (await pipe.exec()) ?? [];
    for (const [err, v] of res) out.push(err ? 0 : Number(v ?? 0));
  }
  return out;
}

/** Pressão do Browserless (/pressure): CPU, memória e sessões abertas do navegador dos agentes. */
async function browser() {
  try {
    const c = await getCredentials("browserless");
    if (!c?.url) return null;
    const base = c.url.replace(/^ws/, "http").replace(/\/$/, "");
    const res = await fetch(`${base}/pressure${c.token ? `?token=${encodeURIComponent(c.token)}` : ""}`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { ok: false };
    const p = ((await res.json()) as { pressure?: Record<string, unknown> }).pressure ?? {};
    return {
      ok: true,
      cpu: typeof p.cpu === "number" ? p.cpu : null,
      memory: typeof p.memory === "number" ? p.memory : null,
      running: Number(p.running ?? 0),
      queued: Number(p.queued ?? 0),
      maxConcurrent: Number(p.maxConcurrent ?? 0) || null,
    };
  } catch {
    return { ok: false };
  }
}

/** Visão do servidor: processos, máquina, disco, banco, Redis, navegador e o histórico diário de tamanho. */
export async function serverOverview() {
  const { main, cache, separateCache } = redisHandles();
  // primeira visita do dia antes da limpeza de hora em hora: já tira a foto de hoje
  const today = await one("SELECT 1 FROM storage_daily WHERE day = current_date");
  if (!today) await snapshotStorage().catch(() => {});
  const [procs, pg, redisMain, redisCache, nav, dsk, history] = await Promise.all([
    processes(),
    postgres(),
    redisStats(main, true),
    separateCache ? redisStats(cache, false) : Promise.resolve(null),
    browser(),
    disk(),
    many("SELECT day, db_bytes, files_bytes, redis_bytes, disk_used, disk_total FROM storage_daily WHERE day > current_date - 60 ORDER BY day"),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    processes: procs,
    machine: machine(),
    disk: dsk,
    postgres: pg,
    redis: redisMain,
    redisCache,
    browser: nav,
    history,
    retentionHours: config.MESSAGE_RETENTION_HOURS,
  };
}

// ================= Armazenamento por cliente =================

type Category = "files" | "talk" | "runs" | "finance" | "agenda" | "memory" | "other";
export const CATEGORY_LABEL: Record<Category, string> = {
  files: "Arquivos e mídias",
  talk: "Conversas",
  runs: "Execuções",
  finance: "Finanças",
  agenda: "Agenda e acompanhamentos",
  memory: "Memórias e agentes",
  other: "Conta e outros",
};
const TABLE_CATEGORY: Record<string, Category> = {
  documents: "files",
  media_files: "files",
  conversations: "talk",
  messages: "talk",
  pending_actions: "talk",
  notifications: "talk",
  executions: "runs",
  execution_steps: "runs",
  usage_daily: "runs",
  transactions: "finance",
  budgets: "finance",
  bills: "finance",
  subscriptions: "finance",
  referral_credits: "finance",
  reminders: "agenda",
  watches: "agenda",
  automations: "agenda",
  memories: "memory",
  agent_notes: "memory",
  user_topics: "memory",
  client_agents: "memory",
};
const TABLE_LABEL: Record<string, string> = {
  documents: "Documentos",
  media_files: "Mídias e gravações",
  conversations: "Conversas",
  messages: "Mensagens",
  pending_actions: "Confirmações pendentes",
  notifications: "Notificações",
  executions: "Execuções",
  execution_steps: "Passos das execuções",
  usage_daily: "Uso por dia",
  transactions: "Lançamentos",
  budgets: "Limites",
  bills: "Contas fixas",
  subscriptions: "Assinatura",
  referral_credits: "Créditos de indicação",
  reminders: "Lembretes",
  watches: "De olho",
  automations: "Automações",
  memories: "Memórias",
  agent_notes: "Notas dos agentes",
  user_topics: "Assuntos",
  client_agents: "Agentes do cliente",
  accounts: "Conta do painel",
  contacts: "Contatos",
  channel_links: "Canais ligados",
  link_codes: "Códigos de ligação",
  users: "Cadastro",
  wa_auth: "Sessão do WhatsApp",
  settings: "Configurações",
  integrations: "Integrações",
  invites: "Convites",
  storage_daily: "Histórico de tamanho",
};

/** Tabelas ligadas à pessoa por outra tabela (não têm user_id próprio). */
const VIA: Record<string, { parent: string; fk: string }> = {
  messages: { parent: "conversations", fk: "conversation_id" },
  execution_steps: { parent: "executions", fk: "execution_id" },
};
/** Arquivos guardados: a coluna com o conteúdo, para contar arquivos e bytes de verdade. */
const FILE_TABLES = new Set(["documents", "media_files"]);

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

interface TableRow {
  table: string;
  user_id: string | null;
  rows: number;
  bytes: number;
  recent: number;
  files: number;
  file_bytes: number;
}

let storageCache: { at: number; data: Awaited<ReturnType<typeof computeStorage>> } | null = null;

export async function storageByClient(fresh = false) {
  if (!fresh && storageCache && Date.now() - storageCache.at < 60_000) return storageCache.data;
  const data = await computeStorage();
  storageCache = { at: Date.now(), data };
  return data;
}

/**
 * Quanto cada cliente ocupa: para cada tabela da pessoa, soma o tamanho guardado de cada coluna
 * (pg_column_size não descompacta arquivo grande) e reparte o tamanho real da tabela no disco
 * (dados + índices + TOAST) na mesma proporção. É estimativa, mas soma certinho com o total do banco.
 */
async function computeStorage() {
  const cols = await many<{ table: string; columns: string[]; total: number; has_created: boolean }>(`
    SELECT t.table_name AS table, array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns,
           pg_total_relation_size(to_regclass(quote_ident(t.table_name)))::bigint AS total,
           bool_or(c.column_name = 'created_at') AS has_created
      FROM information_schema.tables t JOIN information_schema.columns c ON c.table_schema = t.table_schema AND c.table_name = t.table_name
     WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
     GROUP BY t.table_name`);
  const byName = new Map(cols.map((c) => [c.table, c]));
  const owned = cols.filter((c) => (c.columns.includes("user_id") && c.table !== "invites") || VIA[c.table]);

  const rows: TableRow[] = [];
  for (const t of owned) {
    const via = VIA[t.table];
    const parent = via ? byName.get(via.parent) : null;
    if (via && !parent?.columns.includes("user_id")) continue;
    const size = ["24", ...t.columns.map((c) => `COALESCE(pg_column_size(t.${ident(c)}), 0)`)].join(" + ");
    const owner = via ? "p.user_id" : "t.user_id";
    const join = via ? `LEFT JOIN ${ident(via.parent)} p ON p.id = t.${ident(via.fk)}` : "";
    const recent = t.has_created ? `COALESCE(SUM(${size}) FILTER (WHERE t.created_at > now() - interval '7 days'), 0)` : "0";
    const files = FILE_TABLES.has(t.table) ? "COUNT(*)" : "0";
    const fileBytes = FILE_TABLES.has(t.table) ? "COALESCE(SUM(t.size), 0)" : "0";
    const res = await query(
      `SELECT ${owner} AS user_id, COUNT(*)::bigint AS rows, COALESCE(SUM(${size}), 0)::bigint AS bytes, ${recent}::bigint AS recent,
              ${files}::bigint AS files, ${fileBytes}::bigint AS file_bytes
         FROM ${ident(t.table)} t ${join} GROUP BY 1`,
    );
    for (const r of res.rows) rows.push({ table: t.table, ...r });
  }

  // reparte o tamanho real de cada tabela (com índices) pela parte de cada pessoa
  const raw = new Map<string, number>();
  for (const r of rows) raw.set(r.table, (raw.get(r.table) ?? 0) + Number(r.bytes));
  const disk = (r: TableRow) => {
    const tableRaw = raw.get(r.table) ?? 0;
    const total = Number(byName.get(r.table)?.total ?? 0);
    return tableRaw ? Math.round((Number(r.bytes) / tableRaw) * total) : 0;
  };

  // memória curta no Redis (pj:conv:<conversa>:msgs), atribuída pela conversa
  const redisBy = new Map<string, number>();
  let redisSampled = false;
  const r = redisHandles().main;
  if (r) {
    try {
      const { keys, capped } = await scanKeys(r, "pj:conv:*:msgs", 20_000);
      redisSampled = capped;
      const sizes = await memoryUsage(r, keys);
      const convIds = keys.map((k) => k.split(":")[2]).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
      const owners = convIds.length ? await many("SELECT id, user_id FROM conversations WHERE id = ANY($1::uuid[])", [convIds]) : [];
      const ownerOf = new Map(owners.map((o) => [o.id, o.user_id]));
      keys.forEach((k, i) => {
        const u = ownerOf.get(k.split(":")[2]);
        if (u) redisBy.set(u, (redisBy.get(u) ?? 0) + (sizes[i] ?? 0));
      });
    } catch {
      /* sem Redis: só o Postgres */
    }
  }

  const people = await many(`
    SELECT u.id, COALESCE(u.full_name, u.name) AS name, u.phone, u.status, u.created_at, u.last_seen_at, a.email
      FROM users u LEFT JOIN accounts a ON a.user_id = u.id WHERE u.phone <> 'playground'`);
  const userBytes = await many("SELECT id, (24 + pg_column_size(u.*))::bigint AS bytes FROM users u");
  const userRowBytes = new Map(userBytes.map((u) => [u.id, Number(u.bytes)]));
  const usersTotal = Number(byName.get("users")?.total ?? 0);
  const usersRaw = userBytes.reduce((a, u) => a + Number(u.bytes), 0) || 1;

  const empty = () => ({ files: 0, talk: 0, runs: 0, finance: 0, agenda: 0, memory: 0, other: 0 }) as Record<Category, number>;
  const clients = new Map(
    people.map((p) => [
      p.id,
      {
        ...p,
        bytes: 0,
        rows: 0,
        recent: 0,
        files: 0,
        fileBytes: 0,
        redisBytes: redisBy.get(p.id) ?? 0,
        categories: empty(),
        tables: [] as { table: string; label: string; category: Category; rows: number; bytes: number }[],
      },
    ]),
  );
  const totals = empty();
  let unowned = 0;
  for (const row of rows) {
    const bytes = disk(row);
    const cat = TABLE_CATEGORY[row.table] ?? "other";
    const c = row.user_id ? clients.get(row.user_id) : undefined;
    if (!c) {
      unowned += bytes;
      continue;
    }
    c.bytes += bytes;
    c.rows += Number(row.rows);
    c.recent += Number(row.recent);
    c.files += Number(row.files);
    c.fileBytes += Number(row.file_bytes);
    c.categories[cat] += bytes;
    totals[cat] += bytes;
    c.tables.push({ table: row.table, label: TABLE_LABEL[row.table] ?? row.table, category: cat, rows: Number(row.rows), bytes });
  }
  // o próprio cadastro da pessoa
  for (const c of clients.values()) {
    const b = Math.round(((userRowBytes.get(c.id) ?? 0) / usersRaw) * usersTotal);
    c.bytes += b;
    c.categories.other += b;
    totals.other += b;
    c.tables.push({ table: "users", label: TABLE_LABEL.users, category: "other", rows: 1, bytes: b });
    c.tables.sort((a: { bytes: number }, b: { bytes: number }) => b.bytes - a.bytes);
  }

  const dbBytes = Number((await one("SELECT pg_database_size(current_database())::bigint AS n"))?.n ?? 0);
  const list = [...clients.values()].sort((a, b) => b.bytes - a.bytes);
  const attributed = list.reduce((a, c) => a + c.bytes, 0);
  return {
    generatedAt: new Date().toISOString(),
    dbBytes,
    attributed,
    /** tabelas da plataforma (sessão do WhatsApp, filas, configurações, catálogo do Postgres) e linhas sem dono */
    platform: Math.max(0, dbBytes - attributed),
    unowned,
    redisBytes: list.reduce((a, c) => a + c.redisBytes, 0),
    redisSampled,
    categories: (Object.keys(CATEGORY_LABEL) as Category[]).map((id) => ({ id, label: CATEGORY_LABEL[id], bytes: totals[id] })),
    clients: list,
  };
}

/** Foto do dia (de hora em hora, no worker): tamanho do banco, dos arquivos, do Redis e do disco. */
export async function snapshotStorage() {
  const row = await one(`
    SELECT pg_database_size(current_database())::bigint AS db,
           (SELECT COALESCE(SUM(size), 0) FROM documents)::bigint + (SELECT COALESCE(SUM(size), 0) FROM media_files)::bigint AS files`);
  let redisBytes = 0;
  const r = redisHandles().main;
  if (r) {
    try {
      redisBytes = Number(parseInfo(await r.info("memory")).used_memory ?? 0);
    } catch {
      /* sem Redis */
    }
  }
  const d = await disk();
  await query(
    `INSERT INTO storage_daily (day, db_bytes, files_bytes, redis_bytes, disk_used, disk_total)
     VALUES (current_date, $1, $2, $3, $4, $5)
     ON CONFLICT (day) DO UPDATE SET db_bytes = EXCLUDED.db_bytes, files_bytes = EXCLUDED.files_bytes, redis_bytes = EXCLUDED.redis_bytes,
       disk_used = EXCLUDED.disk_used, disk_total = EXCLUDED.disk_total, updated_at = now()`,
    [row?.db ?? 0, row?.files ?? 0, redisBytes, d?.used ?? null, d?.total ?? null],
  );
}
