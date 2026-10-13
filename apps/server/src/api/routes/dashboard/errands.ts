import type { FastifyInstance } from "fastify";
import { type PrefsPatch, prefsFor, removeChat, savePrefs } from "../../../chatprefs.js";
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
    // jeito de cada conversa (apelido, cor, fixada...), pela chave do número que a tela usa
    const prefs = await prefsFor(uid, [...errands.errands.map((e) => e.phone), ...contacts.map((c) => c.phone)]);
    return { ...errands, contacts, prefs };
  });
  // personalizar a conversa ou mudar o acompanhamento (auto, on = sem prazo, off = parar)
  base.put<{ Params: { phone: string }; Body: PrefsPatch }>("/api/errands/chats/:phone", async (req, reply) => {
    // corpo precisa ser objeto JSON (texto solto chegava como string e quebrava o "in" do savePrefs)
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return reply.code(400).send({ error: "Dados inválidos" });
    const r = await savePrefs(await self(req.account), req.params.phone, req.body);
    return r.ok ? r : reply.code(400).send({ error: r.error });
  });
  // excluir acompanhamento: para, cancela o que estava agendado ou aberto (nada é enviado) e tira da tela
  base.delete<{ Params: { phone: string } }>("/api/errands/chats/:phone", async (req) => removeChat(await self(req.account), req.params.phone));
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
