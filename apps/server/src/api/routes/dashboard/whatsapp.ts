import type { FastifyInstance } from "fastify";
import { config } from "../../../config.js";
import { one, query } from "../../../db/pool.js";
import { checkProfile, updateProfile, type WaProfile } from "../../../whatsapp/profile.js";
import { SESSION_ID, sendWaCommand } from "../../../whatsapp/session.js";

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
  // perfil do número (nome, recado, foto): perfil completo passa mais confiança e protege contra bloqueio
  api.post<{ Body: WaProfile }>("/api/whatsapp/profile", async (req, reply) => {
    if (config.WHATSAPP_PROVIDER !== "baileys") return reply.code(400).send({ error: "WHATSAPP_PROVIDER não é baileys" });
    const checked = checkProfile(req.body ?? {});
    if ("error" in checked) return reply.code(400).send({ error: checked.error });
    try {
      await updateProfile(checked.profile);
    } catch (err) {
      return reply.code(502).send({ error: `O WhatsApp não aceitou agora: ${(err as Error).message}` });
    }
    if (checked.profile.name) await query("UPDATE wa_sessions SET name = $2 WHERE id = $1", [SESSION_ID, checked.profile.name]).catch(() => {});
    return { ok: true };
  });
  api.post("/api/whatsapp/restart", async () => {
    await sendWaCommand({ action: "restart" });
    return { ok: true };
  });
}
