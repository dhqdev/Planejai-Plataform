import type { FastifyInstance } from "fastify";
import { deleteDocument, DOC_MAX_BYTES, documentUsage, getDocument, listDocuments, saveDocument } from "../../documents.js";
import { listNotifications, markRead, unreadCount } from "../../notifications.js";
import { NOBODY, selfUserId } from "../../sharing.js";
import { requireAuth } from "../server.js";

/** Notificações (sino com bolinha) e documentos guardados. Sempre no escopo de quem está logado. */
export async function registerNotificationRoutes(app: FastifyInstance) {
  await app.register(async (base) => {
    base.addHook("preHandler", requireAuth);

    base.get<{ Querystring: { limit?: string } }>("/api/notifications", async (req) => listNotifications(req.account, Number(req.query.limit) || 50));
    base.get("/api/notifications/unread", async (req) => unreadCount(req.account));
    base.post<{ Body: { ids?: number[] } }>("/api/notifications/read", async (req) => {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : undefined;
      await markRead(req.account, ids);
      return { ok: true };
    });

    // Documentos: particulares, cada um vê só os dele (o dono também)

    base.get<{ Querystring: { q?: string; folder?: string } }>("/api/documents", async (req) => {
      const items = await listDocuments((await selfUserId(req.account)) ?? NOBODY, { q: req.query.q, folder: req.query.folder });
      const me = await selfUserId(req.account);
      return { items, usage: me ? await documentUsage(me) : null, max_bytes: DOC_MAX_BYTES };
    });

    base.post<{ Body: { name?: string; mimetype?: string; base64?: string; folder?: string; notes?: string } }>("/api/documents", async (req, reply) => {
      const me = await selfUserId(req.account);
      if (!me) return reply.code(400).send({ error: "Ligue seu WhatsApp à conta para guardar documentos." });
      const b64 = String(req.body?.base64 ?? "").replace(/^data:[^,]*,/, "");
      if (!b64) return reply.code(400).send({ error: "Arquivo vazio" });
      try {
        const doc = await saveDocument({
          userId: me,
          name: String(req.body?.name ?? "documento"),
          mimetype: String(req.body?.mimetype || "application/octet-stream").slice(0, 100),
          data: Buffer.from(b64, "base64"),
          folder: req.body?.folder ?? null,
          notes: req.body?.notes ?? null,
          source: "painel",
        });
        return doc;
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });

    base.get<{ Params: { id: string }; Querystring: { inline?: string } }>("/api/documents/:id/file", async (req, reply) => {
      const doc = await getDocument(req.params.id, (await selfUserId(req.account)) ?? NOBODY);
      if (!doc) return reply.code(404).send({ error: "Documento não encontrado" });
      const disposition = req.query.inline === "1" ? "inline" : "attachment";
      return reply
        .header("Content-Type", doc.mimetype)
        .header("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(doc.name)}`)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "sandbox")
        .header("Cache-Control", "private, no-store")
        .send(doc.data);
    });

    base.delete<{ Params: { id: string } }>("/api/documents/:id", async (req, reply) => {
      if (!(await deleteDocument(req.params.id, (await selfUserId(req.account)) ?? NOBODY))) return reply.code(404).send({ error: "Documento não encontrado" });
      return { ok: true };
    });
  });
}
