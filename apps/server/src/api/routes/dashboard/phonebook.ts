import type { FastifyInstance } from "fastify";
import { clearPhonebook, deleteContact, importContacts, listPhonebook, parseVcf, saveContact } from "../../../phonebook.js";
import { NOBODY, selfUserId } from "../../../sharing.js";
import { isUuid } from "./shared.js";

/**
 * Agenda de contatos (importada do celular). Particular: cada um vê só a sua, inclusive o dono.
 * O .vcf chega como texto (o painel tira as fotos antes); o seletor do Android manda a lista pronta.
 */
export function phonebookRoutes(base: FastifyInstance) {
  const self = async (a: Parameters<typeof selfUserId>[0]) => (await selfUserId(a)) ?? NOBODY;

  base.get<{ Querystring: { q?: string; offset?: string } }>("/api/contatos", async (req) =>
    listPhonebook(await self(req.account), String(req.query.q ?? "").slice(0, 60), 100, Math.max(0, Number(req.query.offset) || 0)),
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
