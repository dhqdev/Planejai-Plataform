import type { FastifyInstance } from "fastify";
import { cancelErrand, discardErrandDraft, listErrands } from "../../../errands.js";
import { NOBODY, selfUserId } from "../../../sharing.js";

/**
 * Recados: a conversa que o assistente está tendo com estabelecimentos em nome da pessoa.
 * Particular: cada um vê só os próprios, inclusive o dono (sem compartilhamento).
 */
export function errandRoutes(base: FastifyInstance) {
  const self = async (a: Parameters<typeof selfUserId>[0]) => (await selfUserId(a)) ?? NOBODY;
  base.get("/api/errands", async (req) => listErrands(await self(req.account)));
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
