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
