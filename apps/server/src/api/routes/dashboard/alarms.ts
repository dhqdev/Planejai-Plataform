import type { FastifyInstance } from "fastify";
import {
  alarmFromToken,
  cancelAlarm,
  getAlarmMode,
  getVapid,
  listAlarms,
  listDevices,
  setAlarmMode,
  snoozeAlarm,
  stopAlarm,
  subscribePush,
  testAlarm,
  twilioReady,
  unsubscribePush,
} from "../../../alarms.js";
import { one } from "../../../db/pool.js";
import { selfUserId } from "../../../sharing.js";
import { isUuid } from "./shared.js";

/**
 * Alarmes (Minha conta e a tela /alarme): ligar a notificação neste aparelho, ver e cancelar alarmes, testar,
 * escolher notificação, ligação ou os dois. Sempre da própria pessoa (WhatsApp ligado ao login).
 */
export function alarmRoutes(base: FastifyInstance) {
  const me = async (req: { account: Parameters<typeof selfUserId>[0] }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    const uid = await selfUserId(req.account);
    if (!uid) reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil para usar alarmes" });
    return uid;
  };

  base.get("/api/alarms", async (req, reply) => {
    const uid = await me(req, reply);
    if (!uid) return;
    const [alarms, devices, mode, twilio, vapid, user] = await Promise.all([
      listAlarms(uid),
      listDevices(uid),
      getAlarmMode(uid),
      twilioReady(),
      getVapid(),
      one<{ phone: string; timezone: string | null }>("SELECT phone, timezone FROM users WHERE id = $1", [uid]),
    ]);
    return {
      alarms,
      devices: devices.map((d) => ({ endpoint: d.endpoint, userAgent: d.user_agent, createdAt: d.created_at, lastUsedAt: d.last_used_at })),
      mode: twilio ? mode : "push",
      callAvailable: twilio,
      phone: user?.phone ?? null,
      vapidPublicKey: vapid.publicKey,
    };
  });

  base.put<{ Body: { mode?: string } }>("/api/alarms/settings", async (req, reply) => {
    const uid = await me(req, reply);
    if (!uid) return;
    const mode = String(req.body?.mode ?? "");
    if (mode !== "push" && !(await twilioReady())) return reply.code(400).send({ error: "Ligação ainda não está disponível na plataforma" });
    try {
      await setAlarmMode(uid, mode);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    return { ok: true, mode };
  });

  base.post<{ Body: { subscription?: any } }>("/api/push/subscribe", async (req, reply) => {
    const uid = await me(req, reply);
    if (!uid) return;
    try {
      await subscribePush(uid, req.body?.subscription ?? {}, req.headers["user-agent"] ?? null);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    return { ok: true };
  });

  base.post<{ Body: { endpoint?: string } }>("/api/push/unsubscribe", async (req, reply) => {
    const uid = await me(req, reply);
    if (!uid) return;
    return { ok: await unsubscribePush(uid, String(req.body?.endpoint ?? "")) };
  });

  base.post<{ Body: { call?: boolean } }>("/api/alarms/test", async (req, reply) => {
    const uid = await me(req, reply);
    if (!uid) return;
    if (req.body?.call && !(await twilioReady())) return reply.code(400).send({ error: "Ligação ainda não está disponível na plataforma" });
    return testAlarm(uid, { call: Boolean(req.body?.call) });
  });

  base.delete<{ Params: { id: string } }>("/api/alarms/:id", async (req, reply) => {
    const uid = await me(req, reply);
    if (!uid) return;
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "Alarme não encontrado" });
    return { ok: await cancelAlarm(req.params.id, uid) };
  });

  base.post<{ Params: { id: string; action: string } }>("/api/alarms/:id/:action", async (req, reply) => {
    const uid = await me(req, reply);
    if (!uid) return;
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "Alarme não encontrado" });
    return runAction(req.params.id, req.params.action, uid, reply);
  });
}

async function runAction(id: string, action: string, uid: string | undefined, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  if (action === "stop") return { ok: await stopAlarm(id, uid) };
  if (action === "snooze") {
    const at = await snoozeAlarm(id, uid);
    return at ? { ok: true, ringAt: at.toISOString() } : reply.code(409).send({ error: "Esse alarme não está tocando ou já passou do limite de soneca" });
  }
  return reply.code(404).send({ error: "Ação desconhecida" });
}

/** Botões da notificação (service worker): sem login, autorizados pelo token assinado que veio no push. */
export function alarmActionRoutes(app: FastifyInstance) {
  app.post<{ Body: { token?: string; action?: string } }>("/api/alarm-action", async (req, reply) => {
    const id = alarmFromToken(req.body?.token);
    if (!id) return reply.code(401).send({ error: "Link do alarme vencido" });
    return runAction(id, String(req.body?.action ?? ""), undefined, reply);
  });
}
