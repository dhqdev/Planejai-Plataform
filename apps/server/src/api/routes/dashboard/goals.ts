import type { FastifyInstance } from "fastify";
import { config } from "../../../config.js";
import { one } from "../../../db/pool.js";
import { createGoal, deleteGoal, goalMoves, goalProgress, listGoals, moveGoal, updateGoal, type GoalRow } from "../../../goals.js";
import { NOBODY, personalUser, selfUserId } from "../../../sharing.js";
import { isoLocal } from "../../../time.js";
import { isUuid } from "./shared.js";

/** Metas financeiras (Finanças > Metas): cada um mexe nas suas; quem tem as finanças compartilhadas só vê. */
export function goalRoutes(base: FastifyInstance) {
  const view = async (uid: string, rows: GoalRow[]) => {
    const u = await one("SELECT timezone FROM users WHERE id = $1", [uid]);
    const today = isoLocal(new Date(), u?.timezone ?? config.DEFAULT_TIMEZONE).slice(0, 10);
    return rows.map((g) => ({ ...g, ...goalProgress(g, today) }));
  };
  const mine = async (req: { account: any }, reply: any) => {
    const uid = await selfUserId(req.account);
    if (!uid) reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil para criar metas" });
    return uid;
  };
  const fail = (reply: any, err: unknown) => reply.code(400).send({ error: (err as Error).message });

  base.get<{ Querystring: { user?: string } }>("/api/goals", async (req, reply) => {
    const uid = await personalUser(req.account, req.query.user, "finance");
    if (!uid) return reply.code(403).send({ error: "Essa pessoa não compartilhou as finanças com você" });
    return view(uid, await listGoals(uid));
  });
  base.post<{ Body: { title?: string; target?: unknown; deadline?: string | null; saved?: unknown } }>("/api/goals", async (req, reply) => {
    const uid = await mine(req, reply);
    if (!uid) return;
    try {
      return (await view(uid, [await createGoal(uid, req.body ?? {})]))[0];
    } catch (err) {
      return fail(reply, err);
    }
  });
  base.patch<{ Params: { id: string }; Body: { title?: string; target?: unknown; deadline?: string | null } }>("/api/goals/:id", async (req, reply) => {
    const uid = await mine(req, reply);
    if (!uid) return;
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "Meta não encontrada" });
    try {
      return (await view(uid, [await updateGoal(uid, req.params.id, req.body ?? {})]))[0];
    } catch (err) {
      return fail(reply, err);
    }
  });
  base.post<{ Params: { id: string }; Body: { amount?: unknown; withdraw?: boolean; note?: string } }>("/api/goals/:id/move", async (req, reply) => {
    const uid = await mine(req, reply);
    if (!uid) return;
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "Meta não encontrada" });
    try {
      return (await view(uid, [await moveGoal(uid, req.params.id, req.body?.amount, Boolean(req.body?.withdraw), req.body?.note)]))[0];
    } catch (err) {
      return fail(reply, err);
    }
  });
  base.get<{ Params: { id: string } }>("/api/goals/:id/moves", async (req) => (isUuid(req.params.id) ? goalMoves((await selfUserId(req.account)) ?? NOBODY, req.params.id) : []));
  base.delete<{ Params: { id: string } }>("/api/goals/:id", async (req, reply) =>
    isUuid(req.params.id) && (await deleteGoal((await selfUserId(req.account)) ?? NOBODY, req.params.id)) ? { ok: true } : reply.code(404).send({ error: "Meta não encontrada" }),
  );
}
