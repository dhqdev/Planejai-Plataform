import { createHash } from "node:crypto";

/**
 * Ferramentas cujo resultado é público e pode ser reaproveitado entre pessoas por um tempo:
 * a mesma busca ou página lida de novo não gasta API nem token do pesquisador.
 */
const TOOL_CACHE_SECONDS: Record<string, number> = {
  web_search: 6 * 3600,
  fetch_url: 6 * 3600,
  mercadolivre_search: 3600,
  places_nearby: 6 * 3600,
};

export function toolCacheKey(name: string, args: unknown): { key: string; ttl: number } | null {
  const ttl = TOOL_CACHE_SECONDS[name];
  if (!ttl) return null;
  const norm = JSON.stringify(args, Object.keys((args as object) ?? {}).sort()).toLowerCase();
  return { key: `tool:${name}:${createHash("sha1").update(norm).digest("hex")}`, ttl };
}
