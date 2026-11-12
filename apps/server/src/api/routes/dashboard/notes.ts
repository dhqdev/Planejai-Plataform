import type { FastifyInstance } from "fastify";
import { createNote, deleteNote, getNote, listNotes, noteVersion, noteVersions, restoreNoteVersion, updateNote } from "../../../notes.js";
import { NOBODY, selfUserId } from "../../../sharing.js";
import { isUuid } from "./shared.js";

/**
 * Anotações (aba estilo Google Docs). Particulares: cada um vê e edita só as suas, inclusive o dono.
 * O conteúdo chega do editor como HTML e é limpo no servidor (notes.ts) antes de gravar.
 */
export function noteRoutes(base: FastifyInstance) {
  const self = async (a: Parameters<typeof selfUserId>[0]) => (await selfUserId(a)) ?? NOBODY;

  base.get<{ Querystring: { q?: string } }>("/api/anotacoes", async (req) => ({ items: await listNotes(await self(req.account), String(req.query.q ?? "").trim()) }));

  base.post<{ Body: { title?: string; html?: string } }>("/api/anotacoes", async (req, reply) => {
    const uid = await selfUserId(req.account);
    if (!uid) return reply.code(400).send({ error: "Conta sem WhatsApp ligado" });
    try {
      return await createNote(uid, { title: req.body?.title, html: req.body?.html }, "pessoa");
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  base.get<{ Params: { id: string } }>("/api/anotacoes/:id", async (req, reply) => {
    const n = isUuid(req.params.id) ? await getNote(await self(req.account), req.params.id) : null;
    return n ?? reply.code(404).send({ error: "Anotação não encontrada" });
  });

  /** Salvamento automático do editor. `since` = updated_at da versão aberta: se o Planejai escreveu depois, 409 com a versão nova. */
  base.patch<{ Params: { id: string }; Body: { title?: string; html?: string; pinned?: boolean; since?: string; force?: boolean } }>(
    "/api/anotacoes/:id",
    async (req, reply) => {
      if (!isUuid(req.params.id)) return reply.code(404).send({ error: "Anotação não encontrada" });
      const b = req.body ?? {};
      try {
        const r = await updateNote(
          await self(req.account),
          req.params.id,
          {
            title: typeof b.title === "string" ? b.title : undefined,
            html: typeof b.html === "string" ? b.html : undefined,
            pinned: typeof b.pinned === "boolean" ? b.pinned : undefined,
            since: typeof b.since === "string" ? b.since : null,
            force: b.force === true,
          },
          "pessoa",
        );
        if (!r) return reply.code(404).send({ error: "Anotação não encontrada" });
        if (r.conflict) return reply.code(409).send({ error: "O Planejai escreveu nesta anotação enquanto você editava.", note: r.note });
        return r.note;
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  base.delete<{ Params: { id: string } }>("/api/anotacoes/:id", async (req, reply) => {
    if (!isUuid(req.params.id) || !(await deleteNote(await self(req.account), req.params.id))) return reply.code(404).send({ error: "Anotação não encontrada" });
    return { ok: true };
  });

  base.get<{ Params: { id: string } }>("/api/anotacoes/:id/versoes", async (req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "Anotação não encontrada" });
    return { items: await noteVersions(await self(req.account), req.params.id) };
  });

  base.get<{ Params: { id: string; v: string } }>("/api/anotacoes/:id/versoes/:v", async (req, reply) => {
    const v = isUuid(req.params.id) ? await noteVersion(await self(req.account), req.params.id, req.params.v) : null;
    return v ?? reply.code(404).send({ error: "Versão não encontrada" });
  });

  base.post<{ Params: { id: string; v: string } }>("/api/anotacoes/:id/versoes/:v/restaurar", async (req, reply) => {
    const n = isUuid(req.params.id) ? await restoreNoteVersion(await self(req.account), req.params.id, req.params.v) : null;
    return n ?? reply.code(404).send({ error: "Versão não encontrada" });
  });
}
