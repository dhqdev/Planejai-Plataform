import { Redis } from "ioredis";
import { config } from "./config.js";

/**
 * Memória curta das conversas no Redis próprio da stack.
 * Cada conversa guarda as últimas mensagens já "interpretadas" (áudio transcrito, foto descrita,
 * documento lido), então o agente não reprocessa nada e o contexto sai barato. Tudo expira sozinho
 * em MESSAGE_RETENTION_HOURS (padrão 24h); o que importa a longo prazo vira resumo e memória no Postgres.
 */
export interface ShortEntry {
  id: number;
  role: "user" | "assistant" | "event";
  text: string;
  /** epoch ms */
  ts: number;
  /** id da mensagem no WhatsApp (para reagir/citar) */
  ext?: string | null;
}

const MAX_ENTRIES = 60;
const ttlSeconds = () => Math.max(1, Math.round(config.MESSAGE_RETENTION_HOURS * 3600));
const key = (conversationId: string) => `pj:conv:${conversationId}:msgs`;

let client: Redis | null = null;
let failedAt = 0;

function redis(): Redis | null {
  if (!config.REDIS_URL) return null;
  // se o Redis caiu, segue sem ele por 30s (o Postgres continua sendo a fonte)
  if (failedAt && Date.now() - failedAt < 30_000) return null;
  if (!client) {
    client = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
    client.on("error", () => {
      failedAt = Date.now();
    });
  }
  return client;
}

/** Redis respondendo agora? (decide se dá para não guardar a mensagem no Postgres) */
export async function redisAlive(): Promise<boolean> {
  const r = redis();
  if (!r) return false;
  try {
    return (await r.ping()) === "PONG";
  } catch {
    failedAt = Date.now();
    return false;
  }
}

export function shortMemoryEnabled() {
  return Boolean(config.REDIS_URL);
}

export async function pushShort(conversationId: string, entries: ShortEntry[]) {
  const r = redis();
  if (!r || !entries.length) return;
  try {
    const k = key(conversationId);
    await r
      .multi()
      .rpush(k, ...entries.map((e) => JSON.stringify(e)))
      .ltrim(k, -MAX_ENTRIES, -1)
      .expire(k, ttlSeconds())
      .exec();
  } catch {
    failedAt = Date.now();
  }
}

/** Últimas mensagens dentro da janela de retenção, ou null se o Redis não estiver disponível/vazio. */
export async function recentShort(conversationId: string, limit: number): Promise<ShortEntry[] | null> {
  const r = redis();
  if (!r) return null;
  try {
    const raw = await r.lrange(key(conversationId), -limit, -1);
    if (!raw.length) return null;
    const cutoff = Date.now() - ttlSeconds() * 1000;
    return raw.map((s) => JSON.parse(s) as ShortEntry).filter((e) => e.ts >= cutoff);
  } catch {
    failedAt = Date.now();
    return null;
  }
}

/** Todas as entradas guardadas da conversa (para resumir antes de expirar). */
export async function allShort(conversationId: string): Promise<ShortEntry[] | null> {
  return recentShort(conversationId, MAX_ENTRIES);
}

// ---------------- Cache reaproveitável ----------------
// Resultado de pesquisa, página lida, interpretação de mídia, texto de documento: guardado com validade e
// reaproveitado quando alguém (a mesma pessoa ou outra) precisar de novo. Cada acerto é token economizado.

const CACHE_PREFIX = "pj:cache:";

export async function cacheGet<T>(key: string): Promise<T | null> {
  const r = redis();
  if (!r) return null;
  try {
    const raw = await r.get(CACHE_PREFIX + key);
    if (raw == null) return null;
    void r.incr("pj:stats:cache_hits").catch(() => {});
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number) {
  const r = redis();
  if (!r) return;
  try {
    const raw = JSON.stringify(value);
    if (raw.length > 512_000) return; // nada gigante no Redis
    await r.set(CACHE_PREFIX + key, raw, "EX", Math.max(1, Math.round(ttlSeconds)));
    void r.incr("pj:stats:cache_writes").catch(() => {});
  } catch {
    /* sem cache, segue */
  }
}

/** Busca no cache ou calcula e guarda. */
export async function cached<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit != null) return hit;
  const value = await fn();
  if (value != null) await cacheSet(key, value, ttlSeconds);
  return value;
}

/** Marca algo como visto; devolve false se já tinha sido visto dentro da validade (dedupe barato). */
export async function markSeen(key: string, ttlSeconds: number): Promise<boolean | null> {
  const r = redis();
  if (!r) return null;
  try {
    return (await r.set(`pj:seen:${key}`, "1", "EX", ttlSeconds, "NX")) === "OK";
  } catch {
    return null;
  }
}

/** Conta eventos numa janela (ritmo de mensagens). null = Redis indisponível. */
export async function countInWindow(key: string, windowSeconds: number): Promise<number | null> {
  const r = redis();
  if (!r) return null;
  try {
    const k = `pj:rate:${key}`;
    const [[, n]] = (await r.multi().incr(k).expire(k, windowSeconds, "NX").exec()) as [[unknown, number]];
    return n;
  } catch {
    return null;
  }
}

export async function cacheStats() {
  const r = redis();
  if (!r) return null;
  try {
    const [hits, writes] = await r.mget("pj:stats:cache_hits", "pj:stats:cache_writes");
    let keys = 0;
    let cursor = "0";
    do {
      const [next, batch] = await r.scan(cursor, "MATCH", `${CACHE_PREFIX}*`, "COUNT", 500);
      cursor = next;
      keys += batch.length;
    } while (cursor !== "0" && keys < 50_000);
    return { hits: Number(hits ?? 0), writes: Number(writes ?? 0), keys };
  } catch {
    return null;
  }
}

export async function clearShort(conversationId: string) {
  const r = redis();
  if (!r) return;
  await r.del(key(conversationId)).catch(() => {});
}

export async function redisInfo(): Promise<{ enabled: boolean; ok: boolean; keys?: number; memory?: string }> {
  const r = redis();
  if (!r) return { enabled: shortMemoryEnabled(), ok: false };
  try {
    const keys = await r.dbsize();
    const mem = (await r.info("memory")).match(/used_memory_human:(\S+)/)?.[1];
    return { enabled: true, ok: true, keys, memory: mem };
  } catch {
    return { enabled: true, ok: false };
  }
}

export async function closeShort() {
  await client?.quit().catch(() => {});
  client = null;
}
