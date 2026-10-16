import type { FastifyInstance } from "fastify";
import { MEET_LIMITS, addChunk, deleteMeet, getMeet, listMeets, startMeet, stopMeet } from "../../../meet.js";
import { selfUserId } from "../../../sharing.js";

/** Secretária de reuniões: o painel no notebook manda o áudio da guia do Meet em trechos. Cada um vê só as suas. */
export function meetRoutes(base: FastifyInstance) {
  const me = async (req: { account: Parameters<typeof selfUserId>[0] }) => selfUserId(req.account);
  const noUser = { error: "Ligue seu WhatsApp ao perfil para usar a secretária de reuniões" };

  base.get("/api/meet", async (req, reply) => {
    const uid = await me(req);
    return uid ? { items: await listMeets(uid) } : reply.code(400).send(noUser);
  });
  base.post<{ Body: { title?: string } }>("/api/meet", async (req, reply) => {
    const uid = await me(req);
    return uid ? startMeet(uid, req.body?.title) : reply.code(400).send(noUser);
  });
  base.get<{ Params: { id: string } }>("/api/meet/:id", async (req, reply) => {
    const uid = await me(req);
    const s = uid ? await getMeet(uid, req.params.id) : null;
    return s ?? reply.code(404).send({ error: "Reunião não encontrada" });
  });
  base.post<{ Params: { id: string }; Body: { seq?: number; mimetype?: string; base64?: string } }>("/api/meet/:id/chunk", async (req, reply) => {
    const uid = await me(req);
    if (!uid) return reply.code(400).send(noUser);
    const b64 = String(req.body?.base64 ?? "").replace(/^data:[^,]*,/, "");
    if (b64.length > (MEET_LIMITS.chunkBytes * 4) / 3 + 8) return reply.code(413).send({ error: "Trecho grande demais" });
    const r = await addChunk(uid, req.params.id, Number(req.body?.seq), Buffer.from(b64, "base64"), String(req.body?.mimetype || "audio/webm"));
    return r.ok ? r : reply.code(r.status).send({ error: r.error });
  });
  base.post<{ Params: { id: string } }>("/api/meet/:id/stop", async (req, reply) => {
    const uid = await me(req);
    if (!uid) return reply.code(400).send(noUser);
    return (await stopMeet(uid, req.params.id)) ? { ok: true } : reply.code(404).send({ error: "Essa reunião já foi encerrada" });
  });
  base.delete<{ Params: { id: string } }>("/api/meet/:id", async (req, reply) => {
    const uid = await me(req);
    return uid && (await deleteMeet(uid, req.params.id)) ? { ok: true } : reply.code(404).send({ error: "Reunião não encontrada" });
  });
}
