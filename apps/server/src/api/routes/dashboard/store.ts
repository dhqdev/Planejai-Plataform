import type { FastifyInstance } from "fastify";
import { activateStore, deactivateStore, listStore } from "../../../agent/store.js";
import { one } from "../../../db/pool.js";
import { selfUserId } from "../../../sharing.js";

/** Loja de especialistas: cada pessoa liga e desliga os dela (o dono também, no time dele). */
export function storeRoutes(base: FastifyInstance) {
  base.get("/api/store", async (req, reply) => {
    const uid = await selfUserId(req.account);
    if (!uid) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil para montar seu time" });
    // número do assistente: os pedidos de exemplo abrem o WhatsApp já escritos
    const wa = await one("SELECT phone FROM wa_sessions WHERE phone IS NOT NULL ORDER BY updated_at DESC NULLS LAST LIMIT 1").catch(() => null);
    return { ...(await listStore(uid)), assistant: wa?.phone ? String(wa.phone).split(/[:@]/)[0]!.replace(/\D/g, "") || null : null };
  });
  base.post<{ Params: { slug: string } }>("/api/store/:slug", async (req, reply) => {
    const uid = await selfUserId(req.account);
    if (!uid) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil para montar seu time" });
    const r = await activateStore(uid, req.params.slug);
    return r.ok ? r : reply.code(r.status).send({ error: r.error });
  });
  base.delete<{ Params: { slug: string } }>("/api/store/:slug", async (req, reply) => {
    const uid = await selfUserId(req.account);
    if (!uid) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil para montar seu time" });
    return (await deactivateStore(uid, req.params.slug)) ? { ok: true } : reply.code(404).send({ error: "Esse especialista não está ligado" });
  });
}
