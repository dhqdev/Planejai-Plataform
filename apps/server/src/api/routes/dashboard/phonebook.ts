import type { FastifyInstance } from "fastify";
import { withSignature, getPrefs } from "../../../chatprefs.js";
import { config } from "../../../config.js";
import { one } from "../../../db/pool.js";
import { phoneVariants } from "../../../ingest.js";
import { createDirect, directText } from "../../../direct.js";
import { isNewContact, isOptedOut, OPT_OUT_HINT, OPTED_OUT_ERROR } from "../../../outreach.js";
import { clearPhonebook, deleteContact, importContacts, listPhonebook, parseVcf, renameContact, saveContact } from "../../../phonebook.js";
import { NOBODY, selfUserId } from "../../../sharing.js";
import { isUuid } from "./shared.js";

/**
 * Agenda de contatos (importada do celular). Particular: cada um vê só a sua, inclusive o dono.
 * O .vcf chega como texto (o painel tira as fotos antes); o seletor do Android manda a lista pronta.
 */
export function phonebookRoutes(base: FastifyInstance) {
  const self = async (a: Parameters<typeof selfUserId>[0]) => (await selfUserId(a)) ?? NOBODY;

  base.get<{ Querystring: { q?: string; offset?: string; limit?: string; sem_nome?: string } }>("/api/contatos", async (req) =>
    listPhonebook(
      await self(req.account),
      String(req.query.q ?? "").slice(0, 60),
      Math.min(300, Math.max(1, Number(req.query.limit) || 100)),
      Math.max(0, Number(req.query.offset) || 0),
      req.query.sem_nome === "1",
    ),
  );

  base.post<{ Body: { vcf?: string; contacts?: unknown } }>("/api/contatos/importar", async (req, reply) => {
    const uid = await selfUserId(req.account);
    if (!uid) return reply.code(400).send({ error: "Conta sem WhatsApp ligado" });
    const body = req.body ?? {};
    const list = typeof body.vcf === "string" ? parseVcf(body.vcf) : Array.isArray(body.contacts) ? (body.contacts as any[]) : null;
    if (!list) return reply.code(400).send({ error: "Mande o arquivo .vcf ou a lista de contatos." });
    if (!list.length) return reply.code(400).send({ error: "Nenhum contato com número nesse arquivo." });
    return importContacts(uid, list, typeof body.vcf === "string" ? "vcf" : "celular");
  });

  base.post<{ Body: { name?: string; phone?: string } }>("/api/contatos", async (req, reply) => {
    const uid = await selfUserId(req.account);
    if (!uid) return reply.code(400).send({ error: "Conta sem WhatsApp ligado" });
    try {
      return await saveContact(uid, String(req.body?.name ?? ""), String(req.body?.phone ?? ""), "manual");
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  base.patch<{ Params: { id: string }; Body: { name?: string } }>("/api/contatos/:id", async (req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "Contato não encontrado" });
    try {
      return await renameContact(await self(req.account), req.params.id, String(req.body?.name ?? ""));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /**
   * Mandar mensagem a partir do cartão: sem `confirm` só devolve o texto exato que vai sair (apresentação,
   * assinatura, aviso do SAIR no primeiro contato); com `confirm` a pessoa já viu e tocou em Enviar no painel,
   * e sai pelo mesmo caminho da mensagem avulsa (limites, SAIR, ritmo de número novo, resposta volta pra ela).
   */
  base.post<{ Params: { id: string }; Body: { message?: string; confirm?: boolean } }>("/api/contatos/:id/mensagem", async (req, reply) => {
    const uid = await selfUserId(req.account);
    if (!uid) return reply.code(400).send({ error: "Conta sem WhatsApp ligado" });
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "Contato não encontrado" });
    const c = await one<{ name: string; phone: string }>("SELECT name, phone FROM phonebook WHERE user_id = $1 AND id = $2", [uid, req.params.id]);
    if (!c) return reply.code(404).send({ error: "Contato não encontrado" });
    const message = String(req.body?.message ?? "").trim().slice(0, 2000);
    if (!message) return reply.code(400).send({ error: "Escreva a mensagem." });
    const user = await one<{ id: string; phone: string; name: string | null; full_name: string | null; timezone: string | null }>(
      "SELECT id, phone, name, full_name, timezone FROM users WHERE id = $1",
      [uid],
    );
    if (!user) return reply.code(400).send({ error: "Conta sem WhatsApp ligado" });
    if (await isOptedOut(c.phone)) return reply.code(400).send({ error: OPTED_OUT_ERROR });
    const name = /[\p{L}\p{N}]/u.test(c.name) ? c.name : null;
    if (!req.body?.confirm) {
      const text = withSignature(directText(message, user), (await getPrefs(uid, c.phone))?.signature);
      const firstTime = (await isNewContact(c.phone)) && !(await one("SELECT 1 FROM users WHERE phone = ANY($1) AND status = 'active'", [phoneVariants(c.phone)]));
      return { preview: firstTime ? `${text}\n\n${OPT_OUT_HINT}` : text, to: name ?? `+${c.phone}` };
    }
    const r: any = await createDirect({ user, phone: c.phone, name, message, timezone: user.timezone ?? config.DEFAULT_TIMEZONE });
    if (!r.ok) return reply.code(400).send({ error: r.error ?? "Não deu para mandar." });
    return { ok: true, queued: Boolean(r.tip && !r.sent_to), tip: r.tip ?? null };
  });

  base.delete<{ Params: { id: string } }>("/api/contatos/:id", async (req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "Contato não encontrado" });
    await deleteContact(await self(req.account), req.params.id);
    return { ok: true };
  });

  base.delete("/api/contatos", async (req) => {
    await clearPhonebook(await self(req.account));
    return { ok: true };
  });
}
