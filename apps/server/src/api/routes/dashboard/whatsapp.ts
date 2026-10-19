import type { FastifyInstance } from "fastify";
import { config } from "../../../config.js";
import { many, one, query } from "../../../db/pool.js";
import { SESSION_ID, sendWaCommand } from "../../../whatsapp/session.js";
import { SCENES, makeDraft, monthlyCostUsd, postDraft, saveStatusSettings, statusAudience, statusSettings, type DraftKind, type StatusSettings } from "../../../wa-status.js";

/** WhatsApp embutido (Baileys, só super admin): status e comandos para quem segura a conexão. */
export function whatsappRoutes(api: FastifyInstance) {
  // ---------- WhatsApp embutido (Baileys) ----------
  api.get("/api/whatsapp", async () => {
    const session = await one("SELECT status, qr, pairing_code, phone, name, last_error, updated_at, heartbeat_at, last_message_at, down_since, COALESCE(heartbeat_at > now() - interval '60 seconds', false) AS listening FROM wa_sessions WHERE id = $1", [SESSION_ID]);
    return { provider: config.WHATSAPP_PROVIDER, session };
  });
  api.post<{ Body: { phone?: string } }>("/api/whatsapp/connect", async (req, reply) => {
    if (config.WHATSAPP_PROVIDER !== "baileys") return reply.code(400).send({ error: "WHATSAPP_PROVIDER não é baileys" });
    const phone = req.body?.phone?.replace(/\D/g, "");
    await query("UPDATE wa_sessions SET status = 'connecting', qr = NULL, pairing_code = NULL, last_error = NULL, updated_at = now() WHERE id = $1", [SESSION_ID]);
    await sendWaCommand({ action: "connect", phone: phone || undefined });
    return { ok: true };
  });
  api.post("/api/whatsapp/logout", async () => {
    await sendWaCommand({ action: "logout" });
    return { ok: true };
  });
  // ---------- Status do WhatsApp (wa-status.ts): rascunhos, postar agora e o automático ----------
  api.get("/api/whatsapp/status-posts", async () => {
    const [settings, posts, audience] = await Promise.all([
      statusSettings(),
      many(
        `SELECT id, kind, scene, caption, status, recipients, error, cost_usd, created_at, posted_at
           FROM wa_status_posts ORDER BY created_at DESC LIMIT 30`,
      ),
      statusAudience(),
    ]);
    return { settings, posts, audience: audience.length, monthlyUsd: monthlyCostUsd(settings), scenes: SCENES.map((s) => ({ id: s.id, caption: s.caption })) };
  });
  api.get<{ Params: { id: string } }>("/api/whatsapp/status-posts/:id/img", async (req, reply) => {
    const row = await one<{ mimetype: string; data: Buffer }>("SELECT mimetype, data FROM wa_status_posts WHERE id = $1", [req.params.id]).catch(() => null);
    if (!row) return reply.code(404).send({ error: "não encontrado" });
    return reply.type(row.mimetype).header("Cache-Control", "private, max-age=86400").header("X-Content-Type-Options", "nosniff").send(row.data);
  });
  api.post<{ Body: { kind?: DraftKind; scene?: string } }>("/api/whatsapp/status-posts", async (req, reply) => {
    const kind: DraftKind = req.body?.kind === "blog" ? "blog" : "imagem";
    try {
      return await makeDraft(kind, typeof req.body?.scene === "string" ? req.body.scene : undefined);
    } catch (err) {
      return reply.code(502).send({ error: `Não deu para gerar agora: ${(err as Error).message}` });
    }
  });
  api.patch<{ Params: { id: string }; Body: { caption?: string } }>("/api/whatsapp/status-posts/:id", async (req, reply) => {
    const caption = String(req.body?.caption ?? "").trim();
    if (!caption || caption.length > 700) return reply.code(400).send({ error: "A legenda precisa ter de 1 a 700 letras." });
    await query("UPDATE wa_status_posts SET caption = $2 WHERE id = $1 AND status <> 'postado'", [req.params.id, caption]);
    return { ok: true };
  });
  api.post<{ Params: { id: string } }>("/api/whatsapp/status-posts/:id/post", async (req, reply) => {
    try {
      return { ok: true, recipients: await postDraft(req.params.id) };
    } catch (err) {
      return reply.code(502).send({ error: `O WhatsApp não aceitou agora: ${(err as Error).message}` });
    }
  });
  api.delete<{ Params: { id: string } }>("/api/whatsapp/status-posts/:id", async (req) => {
    await query("DELETE FROM wa_status_posts WHERE id = $1 AND status <> 'postado'", [req.params.id]);
    return { ok: true };
  });
  api.put<{ Body: Partial<StatusSettings> }>("/api/whatsapp/status-settings", async (req) => {
    const b = req.body ?? {};
    const settings = await saveStatusSettings({ enabled: b.enabled, everyDays: b.everyDays, hour: b.hour, blogEvery: b.blogEvery });
    return { settings, monthlyUsd: monthlyCostUsd(settings) };
  });
  api.post("/api/whatsapp/restart", async () => {
    await sendWaCommand({ action: "restart" });
    return { ok: true };
  });
}
