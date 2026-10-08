import type { FastifyInstance } from "fastify";
import { scopeUserId } from "../../../accounts.js";
import { many, one, query } from "../../../db/pool.js";
import { isUuid } from "./shared.js";

/** Memórias e arquivos gerados (gravações do navegador, prints). */
export function memoryRoutes(base: FastifyInstance) {
  // ---------- Memórias ----------
  base.get<{ Querystring: { user?: string } }>("/api/memories", async (req) =>
    many(
      `SELECT m.id, m.content, m.tags, m.created_at, u.name AS user_name FROM memories m JOIN users u ON u.id = m.user_id
        WHERE ($1::uuid IS NULL OR m.user_id = $1) ORDER BY m.created_at DESC LIMIT 300`,
      [scopeUserId(req.account) ?? (req.query.user || null)],
    ),
  );
  base.delete<{ Params: { id: string } }>("/api/memories/:id", async (req) => {
    await query("DELETE FROM memories WHERE id = $1 AND ($2::uuid IS NULL OR user_id = $2)", [req.params.id, scopeUserId(req.account)]);
    return { ok: true };
  });

  // ---------- Arquivos gerados (gravações do navegador, prints) ----------
  base.get<{ Params: { id: string } }>("/api/media/:id", async (req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "não encontrado" });
    const f = await one("SELECT mimetype, file_name, data, user_id FROM media_files WHERE id = $1", [req.params.id]);
    const uid = scopeUserId(req.account);
    if (!f || (uid && f.user_id !== uid)) return reply.code(404).send({ error: "não encontrado" });
    reply.header("Content-Type", f.mimetype).header("Content-Disposition", `inline; filename="${f.file_name ?? "arquivo"}"`).header("Cache-Control", "private, max-age=3600");
    return reply.send(f.data);
  });

  base.get("/api/recordings", async (req) =>
    many(
      `SELECT f.id, f.kind, f.mimetype, f.size, f.created_at, f.execution_id, u.name AS user_name FROM media_files f LEFT JOIN users u ON u.id = f.user_id
        WHERE ($1::uuid IS NULL OR f.user_id = $1) ORDER BY f.created_at DESC LIMIT 100`,
      [scopeUserId(req.account)],
    ),
  );
}
