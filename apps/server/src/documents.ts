import { many, one, query } from "./db/pool.js";

/** Documentos guardados pela pessoa (PDF, imagem, planilha): ficam no banco da stack, só dela. */
export const DOC_MAX_BYTES = 15 * 1024 * 1024;
export const DOC_QUOTA_BYTES = 200 * 1024 * 1024;

export interface DocumentRow {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  folder: string | null;
  notes: string | null;
  source: string;
  created_at: string;
}

const COLS = "id, name, mimetype, size, folder, notes, source, created_at";

export function cleanName(name: string, mimetype: string) {
  let n = String(name || "documento").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "documento";
  const ext = { "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png" }[mimetype];
  if (ext && !/\.[a-z0-9]{2,5}$/i.test(n)) n += ext;
  return n;
}

export async function saveDocument(input: { userId: string; name: string; mimetype: string; data: Buffer; folder?: string | null; notes?: string | null; source?: string }) {
  if (!input.data.length) throw new Error("Arquivo vazio");
  if (input.data.length > DOC_MAX_BYTES) throw new Error("Arquivo grande demais (máx. 15 MB)");
  const used = await one<{ n: string }>("SELECT COALESCE(sum(size), 0) AS n FROM documents WHERE user_id = $1", [input.userId]);
  if (Number(used?.n ?? 0) + input.data.length > DOC_QUOTA_BYTES) throw new Error("Espaço de documentos cheio (200 MB). Apague algum para guardar outro.");
  const folder = input.folder?.trim().slice(0, 60) || null;
  return (await one<DocumentRow>(
    `INSERT INTO documents (user_id, name, mimetype, size, data, folder, notes, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLS}`,
    [input.userId, cleanName(input.name, input.mimetype), input.mimetype || "application/octet-stream", input.data.length, input.data, folder, input.notes?.slice(0, 500) ?? null, input.source ?? "painel"],
  ))!;
}

/** userId null = todos (só o super admin). */
export async function listDocuments(userId: string | null, opts: { q?: string; folder?: string } = {}) {
  const params: unknown[] = [userId];
  let where = "($1::uuid IS NULL OR d.user_id = $1)";
  if (opts.q) {
    params.push(`%${opts.q.trim().toLowerCase()}%`);
    where += ` AND (lower(d.name) LIKE $${params.length} OR lower(coalesce(d.notes, '')) LIKE $${params.length} OR lower(coalesce(d.folder, '')) LIKE $${params.length})`;
  }
  if (opts.folder) {
    params.push(opts.folder);
    where += ` AND d.folder = $${params.length}`;
  }
  return many<DocumentRow & { user_id: string; owner_name: string | null }>(
    `SELECT d.id, d.name, d.mimetype, d.size, d.folder, d.notes, d.source, d.created_at, d.user_id, coalesce(u.full_name, u.name, u.phone) AS owner_name
       FROM documents d JOIN users u ON u.id = d.user_id WHERE ${where} ORDER BY d.created_at DESC LIMIT 300`,
    params,
  );
}

export async function getDocument(id: string, userId: string | null) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return one<DocumentRow & { data: Buffer; user_id: string }>(`SELECT ${COLS}, data, user_id FROM documents WHERE id = $1 AND ($2::uuid IS NULL OR user_id = $2)`, [id, userId]);
}

export async function deleteDocument(id: string, userId: string | null) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const r = await query("DELETE FROM documents WHERE id = $1 AND ($2::uuid IS NULL OR user_id = $2)", [id, userId]);
  return (r.rowCount ?? 0) > 0;
}

export async function documentUsage(userId: string) {
  const r = await one<{ n: number; bytes: string }>("SELECT count(*)::int AS n, COALESCE(sum(size), 0) AS bytes FROM documents WHERE user_id = $1", [userId]);
  return { count: r?.n ?? 0, bytes: Number(r?.bytes ?? 0), quota: DOC_QUOTA_BYTES };
}
