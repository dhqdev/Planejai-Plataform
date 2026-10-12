import { many, one } from "./db/pool.js";
import { ownerUserId } from "./sharing.js";

export type Outfit = Record<string, string>;

/**
 * Roupinha do Mochi de cada pessoa: é o avatar dela no painel (ninguém sobe foto).
 * Fica na conta do painel (`accounts.mascot`); a do dono mora em settings. Duas consultas no máximo,
 * nada de uma por pessoa. Quem nunca escolheu fica fora do mapa (o painel veste um visual pelo id).
 */
export async function outfitsOf(userIds: (string | null | undefined)[]): Promise<Map<string, Outfit>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  const out = new Map<string, Outfit>();
  if (!ids.length) return out;
  const rows = await many<{ user_id: string; outfit: Outfit | null }>(
    "SELECT DISTINCT ON (user_id) user_id, mascot->'outfit' AS outfit FROM accounts WHERE user_id = ANY($1) AND mascot IS NOT NULL ORDER BY user_id, created_at",
    [ids],
  );
  for (const r of rows) if (r.outfit && typeof r.outfit === "object") out.set(r.user_id, r.outfit);
  const owner = await ownerUserId();
  if (owner && ids.includes(owner) && !out.has(owner)) {
    const v = (await one<{ value: { outfit?: Outfit } | null }>("SELECT value FROM settings WHERE key = 'owner_mascot'"))?.value;
    if (v?.outfit) out.set(owner, v.outfit);
  }
  return out;
}

/** Junta `outfit` (ou null) a cada linha, pelo id da pessoa. */
export async function withOutfits<T extends Record<string, unknown>>(rows: T[], key: keyof T = "id"): Promise<(T & { outfit: Outfit | null })[]> {
  const map = await outfitsOf(rows.map((r) => r[key] as string | null));
  return rows.map((r) => ({ ...r, outfit: map.get(r[key] as string) ?? null }));
}
