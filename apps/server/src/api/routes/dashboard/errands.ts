import type { FastifyInstance } from "fastify";
import { cancelErrand, discardErrandDraft, listErrands } from "../../../errands.js";
import { listContactChats } from "../../../direct.js";
import { NOBODY, selfUserId } from "../../../sharing.js";

/**
 * Recados: as conversas que o assistente está tendo em nome da pessoa: com estabelecimentos (errands) e com
 * contatos (mensagens avulsas, contatos do Planejai e as respostas, em `contacts`).
 * Particular: cada um vê só os próprios, inclusive o dono (sem compartilhamento).
 */
export function errandRoutes(base: FastifyInstance) {
  const self = async (a: Parameters<typeof selfUserId>[0]) => (await selfUserId(a)) ?? NOBODY;
  base.get("/api/errands", async (req) => {
    const uid = await self(req.account);
    const [errands, contacts] = await Promise.all([listErrands(uid), listContactChats(uid)]);
    return { ...errands, contacts };
  });
  // cancelar não manda nada para o estabelecimento: só para de acompanhar
  base.post<{ Params: { id: string } }>("/api/errands/:id/cancel", async (req, reply) => {
    const r = await cancelErrand(req.params.id, await self(req.account));
    if (!r) return reply.code(404).send({ error: "Recado não encontrado" });
    return r.ok ? { ok: true } : reply.code(409).send({ error: r.error });
  });
  // recado que ainda esperava o "sim": descarta e nada sai
  base.delete<{ Params: { id: string } }>("/api/errands/drafts/:id", async (req, reply) =>
    (await discardErrandDraft(req.params.id, await self(req.account))) ? { ok: true } : reply.code(404).send({ error: "Pedido não encontrado ou já resolvido" }),
  );
}
