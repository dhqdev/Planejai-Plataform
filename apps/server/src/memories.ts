import { one, query } from "./db/pool.js";

/**
 * "O que ele sabe de mim": fatos duradouros sobre a pessoa, separados por assunto.
 * Entram pela conversa (save_memory), pela reunião das 19h ou pela própria pessoa no painel.
 */
export const MEMORY_CATEGORIES: Record<string, string> = {
  perfil: "Quem você é",
  familia: "Família e pessoas",
  trabalho: "Trabalho e estudos",
  rotina: "Rotina",
  gostos: "Gostos",
  saude: "Saúde",
  dinheiro: "Dinheiro",
  objetivos: "Planos e objetivos",
  outros: "Outros",
};
/** assuntos que sempre entram no contexto do CTO (loadMemories pega a tag perfil) */
const PROFILE = new Set(["perfil", "familia", "trabalho"]);

export type MemorySource = "conversa" | "reuniao" | "pessoa";

export function normalizeCategory(c: unknown): string | null {
  const k = String(c ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
  return k in MEMORY_CATEGORIES ? k : null;
}

/**
 * Guarda um fato sem duplicar: se já sabe (todas as palavras do novo estão numa memória) só junta as tags;
 * se o novo detalha um antigo (todas as palavras do antigo estão no novo) ou replacesId aponta um, troca o texto.
 */
export async function rememberFact(
  userId: string,
  text: string,
  opts: { tags?: string[]; category?: string | null; source?: MemorySource; replacesId?: string } = {},
): Promise<{ ok: boolean; error?: string; already_known?: string; updated?: string; created?: string }> {
  const content = text.trim().slice(0, 400);
  if (!content) return { ok: false, error: "Memória vazia" };
  let tags = [...new Set((opts.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 6);
  const category = normalizeCategory(opts.category) ?? tags.map(normalizeCategory).find(Boolean) ?? null;
  if (category && PROFILE.has(category) && !tags.includes("perfil")) tags = [...tags, "perfil"];
  if (!opts.replacesId) {
    const known = await one("SELECT id FROM memories WHERE user_id = $1 AND search @@ plainto_tsquery('portuguese', $2) ORDER BY created_at DESC LIMIT 1", [userId, content]);
    if (known) {
      await query(
        "UPDATE memories SET tags = (SELECT ARRAY(SELECT DISTINCT unnest(tags || $2::text[]))), category = COALESCE(category, $3), created_at = now() WHERE id = $1",
        [known.id, tags, category],
      );
      return { ok: true, already_known: known.id };
    }
  }
  const same =
    opts.replacesId && /^[0-9a-f-]{36}$/i.test(opts.replacesId)
      ? await one("SELECT id FROM memories WHERE id = $1 AND user_id = $2", [opts.replacesId, userId])
      : await one(
          "SELECT id FROM memories WHERE user_id = $1 AND to_tsvector('portuguese', $2) @@ plainto_tsquery('portuguese', content) ORDER BY created_at DESC LIMIT 1",
          [userId, content],
        );
  if (same) {
    await query(
      "UPDATE memories SET content = $3, tags = (SELECT ARRAY(SELECT DISTINCT unnest(tags || $4::text[]))), category = COALESCE($5, category), created_at = now() WHERE id = $1 AND user_id = $2",
      [same.id, userId, content, tags, category],
    );
    return { ok: true, updated: same.id };
  }
  const row = await one<{ id: string }>("INSERT INTO memories (user_id, content, tags, category, source) VALUES ($1, $2, $3, $4, $5) RETURNING id", [
    userId,
    content,
    tags,
    category,
    opts.source ?? "conversa",
  ]);
  return { ok: true, created: row!.id };
}
