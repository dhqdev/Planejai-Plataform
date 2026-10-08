import type { FastifyInstance } from "fastify";
import { scopeUserId } from "../../../accounts.js";
import { CTO, CTO_TOOLS, faceFor, SPECIALISTS } from "../../../agent/team.js";
import { many, one } from "../../../db/pool.js";
import { dailyImprovement, improveUser } from "../../../improve.js";
import { isConnected } from "../../../integrations/registry.js";
import { resolveModel } from "../../../llm/router.js";
import { withLook } from "./shared.js";

/** Time de agentes como cada conta vê: o próprio time e o mapa de quem conversa com quem. */
export function teamRoutes(base: FastifyInstance) {
  base.get("/api/me/team", async (req) => {
    const uid = req.account.userId;
    const core = [CTO, ...SPECIALISTS].map((a) => ({ id: a.id, name: a.name, persona: a.persona, face: a.face, role: a.role, kind: a.id === "cto" ? "cto" : "specialist" }));
    if (!uid) return { core, mine: [] };
    const mine = (await many("SELECT id, slug, name, persona, face, focus, uses, created_at FROM client_agents WHERE user_id = $1 AND active ORDER BY created_at", [uid])).map((a) =>
      withLook(a, uid),
    );
    const notes = await many("SELECT agent, note, user_note FROM agent_notes WHERE user_id = $1", [uid]);
    return { core, mine, notes };
  });

  // ---------- Mapa do time: agentes e com que frequência conversam ----------
  base.get("/api/graph", async (req) => {
    const uid = scopeUserId(req.account);
    const nodes = [
      { id: "cto", name: CTO.name, persona: CTO.persona, face: CTO.face, icon: CTO.icon, role: CTO.role, kind: "cto" },
      ...SPECIALISTS.map((s) => ({ id: s.id, name: s.name, persona: s.persona, face: s.face, icon: s.icon, role: s.role, kind: "specialist" })),
    ] as any[];
    const clients = await many(
      `SELECT ca.id, ca.slug, ca.name, ca.persona, ca.face, ca.user_id, ca.focus, ca.uses, COALESCE(u.full_name, u.name) AS owner FROM client_agents ca JOIN users u ON u.id = ca.user_id
        WHERE ca.active AND ($1::uuid IS NULL OR ca.user_id = $1) ORDER BY ca.uses DESC LIMIT 12`,
      [uid],
    );
    for (const c of clients)
      nodes.push({ id: `c_${c.slug}`, name: c.name, persona: c.persona ?? c.name, face: c.face ?? faceFor(`${c.user_id}:${c.slug}`), icon: "sparkle", role: `${c.focus}${uid ? "" : ` (de ${c.owner})`}`, kind: "client" });
    const edges = await many(
      `SELECT p.agent AS "from", s.agent AS "to", COUNT(*)::int AS n FROM execution_steps s
         JOIN execution_steps p ON p.id = s.parent_id JOIN executions e ON e.id = s.execution_id
        WHERE s.type = 'llm' AND p.type = 'delegate' AND s.agent <> p.agent AND s.started_at > now() - interval '7 days'
          AND ($1::uuid IS NULL OR e.user_id = $1)
        GROUP BY 1, 2`,
      [uid],
    );
    const activity = await many(
      `SELECT s.agent, COUNT(*)::int AS n FROM execution_steps s JOIN executions e ON e.id = s.execution_id
        WHERE s.type = 'llm' AND s.started_at > now() - interval '7 days' AND ($1::uuid IS NULL OR e.user_id = $1) GROUP BY 1`,
      [uid],
    );
    return { nodes, edges, activity: Object.fromEntries(activity.map((a) => [a.agent, a.n])) };
  });
}

/** Time de agentes (só super admin): modelos e ferramentas, agentes de cada cliente e melhoria diária. */
export function teamAdminRoutes(api: FastifyInstance) {
  // ---------- Time de agentes e modelos ----------
  api.get("/api/agents", async () => {
    const describe = async (id: string, name: string, icon: string, role: string, tools: typeof CTO_TOOLS, persona?: string, face?: unknown) => ({
      id,
      name,
      persona,
      face,
      icon,
      role,
      model: (await resolveModel(`agent:${id}`)).model,
      tools: await Promise.all(
        tools.map(async (t) => ({ name: t.name, description: t.description, integration: t.integration ?? null, available: !t.integration || (await isConnected(t.integration)) })),
      ),
    });
    return [
      await describe(CTO.id, CTO.name, CTO.icon, CTO.role, CTO_TOOLS, CTO.persona, CTO.face),
      ...(await Promise.all(SPECIALISTS.map((s) => describe(s.id, s.name, s.icon, s.role, s.tools, s.persona, s.face)))),
    ];
  });

  // ---------- Agentes de cada cliente (melhoria diária) ----------
  api.get("/api/client-agents", async () =>
    many(`SELECT ca.*, COALESCE(u.full_name, u.name, '+' || u.phone) AS owner FROM client_agents ca JOIN users u ON u.id = ca.user_id ORDER BY ca.active DESC, ca.uses DESC`).then((rows) =>
      rows.map((r) => withLook(r, r.user_id)),
    ),
  );

  api.patch<{ Params: { id: string }; Body: { active?: boolean; instructions?: string } }>("/api/client-agents/:id", async (req) =>
    one("UPDATE client_agents SET active = COALESCE($2, active), instructions = COALESCE($3, instructions), updated_at = now() WHERE id = $1 RETURNING *", [
      req.params.id,
      typeof req.body.active === "boolean" ? req.body.active : null,
      req.body.instructions ?? null,
    ]),
  );
  api.get("/api/topics", async () =>
    many(`SELECT t.topic, round(t.score::numeric, 1) AS score, t.days, t.last_at, COALESCE(u.full_name, u.name) AS owner FROM user_topics t JOIN users u ON u.id = t.user_id ORDER BY t.score DESC LIMIT 100`),
  );
  api.post<{ Body: { user?: string } }>("/api/improve/run", async (req) => (req.body?.user ? improveUser(req.body.user) : dailyImprovement()));
}
