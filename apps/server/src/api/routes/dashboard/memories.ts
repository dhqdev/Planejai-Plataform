import type { FastifyInstance } from "fastify";
import type { Account } from "../../../accounts.js";
import { CTO, SPECIALISTS } from "../../../agent/team.js";
import { many, one, query } from "../../../db/pool.js";
import { improveUser } from "../../../improve.js";
import { MEMORY_CATEGORIES, normalizeCategory, rememberFact } from "../../../memories.js";
import { NOBODY, selfUserId } from "../../../sharing.js";
import { readBlob } from "../../../storage.js";
import { isUuid } from "./shared.js";

/** Arquivo é de quem vê; o super admin também vê o do playground e o do sistema (sem pessoa). */
async function canSeeMedia(account: Account, f: { user_id: string | null; phone: string | null }) {
  if (f.user_id && f.user_id === (await selfUserId(account))) return true;
  return account.role === "superadmin" && (!f.user_id || f.phone === "playground");
}

/** Memórias e arquivos gerados (gravações do navegador, prints). */
export function memoryRoutes(base: FastifyInstance) {
  // ---------- Memórias ----------
  // particulares: cada um vê o que o assistente sabe dele (o dono também só as dele)
  const me = async (req: { account: Account }) => (await selfUserId(req.account)) ?? NOBODY;
  base.get("/api/memories", async (req) =>
    many(`SELECT m.id, m.content, m.tags, m.category, m.source, m.created_at FROM memories m WHERE m.user_id = $1 ORDER BY m.created_at DESC LIMIT 300`, [await me(req)]),
  );
  // tudo o que ele sabe: fatos por assunto, jeito de falar, o que cada agente aprendeu e os assuntos frequentes
  base.get("/api/memories/overview", async (req) => {
    const uid = await me(req);
    const [facts, person, notes, topics, last] = await Promise.all([
      many(`SELECT id, content, category, source, created_at FROM memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT 300`, [uid]),
      one("SELECT style_notes FROM users WHERE id = $1", [uid]),
      many("SELECT agent, note FROM agent_notes WHERE user_id = $1 AND note IS NOT NULL ORDER BY agent", [uid]),
      many("SELECT topic, days FROM user_topics WHERE user_id = $1 ORDER BY score DESC LIMIT 12", [uid]),
      one("SELECT created_at FROM improve_meetings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [uid]),
    ]);
    return {
      categories: MEMORY_CATEGORIES,
      facts,
      style: person?.style_notes ?? null,
      notes: notes.map((n) => ({ ...n, ...agentLabel(n.agent) })),
      topics,
      last_meeting_at: last?.created_at ?? null,
    };
  });
  // a própria pessoa ensina um fato
  base.post<{ Body: { content?: string; category?: string } }>("/api/memories", async (req, reply) => {
    const uid = await me(req);
    if (uid === NOBODY) return reply.code(400).send({ error: "Sua conta ainda não está ligada a um WhatsApp" });
    const r = await rememberFact(uid, String(req.body?.content ?? ""), { category: req.body?.category ?? "outros", source: "pessoa" });
    return r.ok ? r : reply.code(400).send({ error: r.error });
  });
  base.patch<{ Params: { id: string }; Body: { content?: string; category?: string } }>("/api/memories/:id", async (req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "não encontrado" });
    const content = typeof req.body?.content === "string" ? req.body.content.trim().slice(0, 400) : null;
    if (content === "") return reply.code(400).send({ error: "Escreva o fato" });
    const row = await one(
      `UPDATE memories SET content = COALESCE($3, content), category = COALESCE($4, category), source = CASE WHEN $3::text IS NULL THEN source ELSE 'pessoa' END
        WHERE id = $1 AND user_id = $2 RETURNING id, content, category, source, created_at`,
      [req.params.id, await me(req), content, normalizeCategory(req.body?.category)],
    );
    return row ?? reply.code(404).send({ error: "não encontrado" });
  });
  base.delete<{ Params: { id: string } }>("/api/memories/:id", async (req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "não encontrado" });
    await query("DELETE FROM memories WHERE id = $1 AND user_id = $2", [req.params.id, await me(req)]);
    return { ok: true };
  });
  // esquecer o jeito de falar ou o que um agente aprendeu (o pedido que a pessoa fez ao agente, user_note, fica)
  base.delete("/api/memories/style", async (req) => {
    await query("UPDATE users SET style_notes = NULL WHERE id = $1", [await me(req)]);
    return { ok: true };
  });
  base.delete<{ Params: { agent: string } }>("/api/memories/notes/:agent", async (req) => {
    const uid = await me(req);
    await query("UPDATE agent_notes SET note = NULL WHERE user_id = $1 AND agent = $2", [uid, req.params.agent]);
    await query("DELETE FROM agent_notes WHERE user_id = $1 AND agent = $2 AND note IS NULL AND user_note IS NULL", [uid, req.params.agent]);
    return { ok: true };
  });

  // ---------- Reuniões das 19h: a ata de cada uma, só da própria pessoa ----------
  base.get("/api/meetings", async (req) => {
    const rows = await many(
      "SELECT id, asks, summary, learned, changes, created_at FROM improve_meetings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 60",
      [await me(req)],
    );
    return rows.map((m) => ({
      ...m,
      changes: { ...m.changes, agent_notes: (m.changes?.agent_notes ?? []).map((n: any) => ({ ...n, ...agentLabel(n.agent) })) },
    }));
  });
  // "Reunião agora" para a própria pessoa (no máximo uma a cada 20 min)
  base.post("/api/meetings/run", async (req, reply) => {
    const uid = await me(req);
    if (uid === NOBODY) return reply.code(400).send({ error: "Sua conta ainda não está ligada a um WhatsApp" });
    const recent = await one("SELECT 1 FROM improve_meetings WHERE user_id = $1 AND created_at > now() - interval '20 minutes'", [uid]);
    if (recent) return reply.code(429).send({ error: "O time acabou de se reunir. Tente de novo daqui a pouco." });
    const r = await improveUser(uid);
    if (!r.meetingId) return reply.code(400).send({ error: "Sem conversa nas últimas 24h para o time revisar." });
    return r;
  });
  // ---------- Arquivos gerados (gravações do navegador, prints) ----------
  base.get<{ Params: { id: string } }>("/api/media/:id", async (req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "não encontrado" });
    const f = await one("SELECT f.mimetype, f.file_name, f.data, f.storage_key, f.user_id, u.phone FROM media_files f LEFT JOIN users u ON u.id = f.user_id WHERE f.id = $1", [req.params.id]);
    if (!f || !(await canSeeMedia(req.account, f))) return reply.code(404).send({ error: "não encontrado" });
    reply.header("Content-Type", f.mimetype).header("Content-Disposition", `inline; filename="${f.file_name ?? "arquivo"}"`).header("Cache-Control", "private, max-age=3600");
    return reply.send(await readBlob(f));
  });

  // gravações e prints são particulares: cada um vê os seus (o dono também vê o playground e o que é do sistema)
  base.get("/api/recordings", async (req) =>
    many(
      `SELECT f.id, f.kind, f.mimetype, f.size, f.created_at, f.execution_id, u.name AS user_name FROM media_files f LEFT JOIN users u ON u.id = f.user_id
        WHERE f.user_id = $1 OR ($2 AND (f.user_id IS NULL OR u.phone = 'playground')) ORDER BY f.created_at DESC LIMIT 100`,
      [(await selfUserId(req.account)) ?? NOBODY, req.account.role === "superadmin"],
    ),
  );
}

/** nome que a pessoa conhece (Juvenal, Moacir...) e o papel do agente */
function agentLabel(id: string) {
  const a = [CTO, ...SPECIALISTS].find((x) => x.id === id);
  return { persona: a?.persona ?? id, name: a?.name ?? id };
}
