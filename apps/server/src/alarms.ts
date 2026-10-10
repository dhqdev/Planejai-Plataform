import webpush from "web-push";
import type PgBoss from "pg-boss";
import { config } from "./config.js";
import { decryptJsonWithInfo, encryptJson, signSession, verifySession } from "./crypto.js";
import { many, one, query } from "./db/pool.js";
import { getCredentials } from "./integrations/registry.js";
import { assertPublicUrl } from "./net.js";
import { QUEUES, getBoss } from "./queue/boss.js";
import { Tracer } from "./agent/trace.js";

/**
 * Alarme: na hora toca no celular como uma ligação (Web Push do PWA, para todo mundo), liga de verdade pelo
 * Twilio da plataforma quando o dono configurou e a pessoa escolheu, e manda "Alarme: ..." no WhatsApp.
 * Sem IA: o disparo é texto pronto. Cada disparo vira uma execução "alarm" em Execuções.
 */

export const MAX_ACTIVE_ALARMS = 20;
/** ligações por pessoa em 24h (custo do Twilio sem teto é o risco) */
export const MAX_ALARM_CALLS_PER_DAY = 10;
export const MAX_SNOOZES = 6;
export type AlarmMode = "push" | "call" | "both";

// ---------------------------------------------------------------- VAPID (chaves do Web Push)

let vapidCache: { publicKey: string; privateKey: string; subject: string } | null = null;

function vapidSubject() {
  if (config.VAPID_SUBJECT) return config.VAPID_SUBJECT;
  return /^https:\/\//.test(config.PUBLIC_URL) && !/localhost/.test(config.PUBLIC_URL) ? config.PUBLIC_URL.replace(/\/$/, "") : `mailto:${config.ADMIN_EMAIL}`;
}

/** Chaves do .env ou, sem elas, um par gerado uma vez e guardado cifrado em settings (vapid_keys). */
export async function getVapid() {
  if (vapidCache) return vapidCache;
  if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
    vapidCache = { publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY, subject: vapidSubject() };
    return vapidCache;
  }
  const read = async () => {
    const row = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'vapid_keys'");
    if (!row?.value) return null;
    const { value, stale } = decryptJsonWithInfo<{ publicKey: string; privateKey: string }>(String(row.value));
    if (stale) await query("UPDATE settings SET value = $1, updated_at = now() WHERE key = 'vapid_keys'", [JSON.stringify(encryptJson(value))]);
    return value;
  };
  let keys = await read();
  if (!keys) {
    const fresh = webpush.generateVAPIDKeys();
    // duas réplicas subindo juntas: a primeira grava, a outra lê a mesma
    await query("INSERT INTO settings (key, value) VALUES ('vapid_keys', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify(encryptJson(fresh))]);
    keys = await read();
  }
  vapidCache = { ...keys!, subject: vapidSubject() };
  return vapidCache;
}

// ---------------------------------------------------------------- Aparelhos (inscrições de push)

/** Serviços de push dos navegadores: o endpoint vem do navegador, então só esses hosts são aceitos. */
const PUSH_HOSTS = ["fcm.googleapis.com", "android.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];

export async function checkPushEndpoint(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Endereço de notificação inválido");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) throw new Error("Serviço de notificação não reconhecido");
  await assertPublicUrl(endpoint);
}

export async function subscribePush(userId: string, sub: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }, userAgent?: string | null) {
  const endpoint = String(sub?.endpoint ?? "");
  const p256dh = String(sub?.keys?.p256dh ?? "");
  const auth = String(sub?.keys?.auth ?? "");
  if (!endpoint || endpoint.length > 1000 || !/^[\w-]{20,200}$/.test(p256dh) || !/^[\w-]{8,100}$/.test(auth)) throw new Error("Inscrição de notificação inválida");
  await checkPushEndpoint(endpoint);
  // o mesmo aparelho trocando de conta passa a ser da conta nova
  await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4, user_agent = $5`,
    [userId, endpoint, p256dh, auth, userAgent?.slice(0, 300) ?? null],
  );
  const n = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = $1", [userId]);
  // no máximo 10 aparelhos por pessoa: sai o mais antigo
  if ((n?.n ?? 0) > 10) {
    await query(
      "DELETE FROM push_subscriptions WHERE id IN (SELECT id FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at ASC LIMIT $2)",
      [userId, n!.n - 10],
    );
  }
}

export async function unsubscribePush(userId: string, endpoint: string) {
  const r = await query("DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2", [userId, endpoint]);
  return (r.rowCount ?? 0) > 0;
}

export async function listDevices(userId: string) {
  return many<{ endpoint: string; user_agent: string | null; created_at: string; last_used_at: string | null }>(
    "SELECT endpoint, user_agent, created_at, last_used_at FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC",
    [userId],
  );
}

/** Manda a notificação para todos os aparelhos da pessoa; inscrição que sumiu (404/410) é apagada. */
export async function sendPush(userId: string, payload: Record<string, unknown>, opts: { ttl?: number } = {}) {
  const subs = await many("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1", [userId]);
  if (!subs.length) return { devices: 0, sent: 0, removed: 0, errors: [] as string[] };
  const v = await getVapid();
  const body = JSON.stringify(payload);
  let sent = 0;
  let removed = 0;
  const errors: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await checkPushEndpoint(s.endpoint);
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
          vapidDetails: { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey },
          TTL: opts.ttl ?? 600,
          urgency: "high",
          timeout: 10_000,
        });
        sent++;
        await query("UPDATE push_subscriptions SET last_used_at = now() WHERE id = $1", [s.id]);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await query("DELETE FROM push_subscriptions WHERE id = $1", [s.id]);
          removed++;
        } else errors.push(status ? `push respondeu ${status}` : (err as Error).message.slice(0, 120));
      }
    }),
  );
  return { devices: subs.length, sent, removed, errors };
}

// ---------------------------------------------------------------- Ligação (Twilio da plataforma)

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

/** Fala o texto duas vezes, com pausa (quem atende no susto perde a primeira). */
export function callTwiml(prefix: string, text: string) {
  const say = `<Say language="pt-BR" voice="Polly.Camila">${prefix}: ${xml(text.slice(0, 200))}</Say>`;
  return `<Response>${say}<Pause length="1"/>${say}</Response>`;
}

export const alarmTwiml = (label: string) => callTwiml("Alarme do Planejai", label);

export async function twilioReady() {
  const c = await getCredentials("twilio");
  return Boolean(c?.account_sid && c.auth_token && c.from_number);
}

async function callsToday(userId: string) {
  const r = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM alarm_calls WHERE user_id = $1 AND created_at > now() - interval '24 hours'", [userId]);
  return r?.n ?? 0;
}

/**
 * Liga para o WhatsApp da pessoa (o mesmo número) e fala o alarme ou o lembrete. Conta no limite diário mesmo se falhar.
 * Só liga para o número da própria pessoa: nunca para terceiros.
 */
export async function placeAlarmCall(
  userId: string,
  phone: string,
  label: string,
  alarmId: string | null,
  opts: { reminderId?: string; prefix?: string } = {},
) {
  const c = await getCredentials("twilio");
  if (!c?.account_sid || !c.auth_token || !c.from_number) return { ok: false, skipped: "Twilio não configurado" };
  const digits = String(phone).replace(/\D/g, "");
  if (!/^\d{10,15}$/.test(digits)) return { ok: false, skipped: "número sem formato de telefone" };
  if (!/^AC[0-9a-f]{32}$/i.test(c.account_sid)) return { ok: false, skipped: "Account SID do Twilio inválido" };
  const used = await callsToday(userId);
  if (used >= MAX_ALARM_CALLS_PER_DAY) return { ok: false, skipped: `limite de ${MAX_ALARM_CALLS_PER_DAY} ligações em 24h` };
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.account_sid}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${c.account_sid}:${c.auth_token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: `+${digits}`, From: c.from_number, Twiml: callTwiml(opts.prefix ?? "Alarme do Planejai", label), Timeout: "30" }),
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = await res.json().catch(() => ({}));
  await query("INSERT INTO alarm_calls (user_id, alarm_id, reminder_id, sid, status) VALUES ($1, $2, $3, $4, $5)", [
    userId,
    alarmId,
    opts.reminderId ?? null,
    j.sid ?? null,
    res.ok ? String(j.status ?? "queued") : `erro ${res.status}`,
  ]);
  if (!res.ok) throw new Error(`Twilio respondeu ${res.status}: ${String(j.message ?? "").slice(0, 160)}`);
  return { ok: true, sid: j.sid ?? null, status: j.status ?? null, calls_24h: used + 1 };
}

// ---------------------------------------------------------------- Preferência da pessoa

export async function getAlarmMode(userId: string): Promise<AlarmMode> {
  const r = await one<{ m: string | null }>("SELECT profile->>'alarm_mode' AS m FROM users WHERE id = $1", [userId]);
  return r?.m === "call" || r?.m === "both" ? r.m : "push";
}

export async function setAlarmMode(userId: string, mode: string) {
  if (!["push", "call", "both"].includes(mode)) throw new Error("Escolha notificação, ligação ou os dois");
  await query("UPDATE users SET profile = profile || jsonb_build_object('alarm_mode', $2::text) WHERE id = $1", [userId, mode]);
}

// ---------------------------------------------------------------- Alarmes

/** Token assinado que vai na notificação: "Parar" e "Soneca" funcionam direto da notificação, sem login. */
export function alarmActionToken(id: string) {
  return signSession({ sub: `alarm:${id}`, exp: Date.now() + 12 * 3600_000 });
}

export function alarmFromToken(token: string | undefined) {
  return verifySession(token)?.sub.match(/^alarm:([0-9a-f-]{36})$/i)?.[1] ?? null;
}

async function enqueue(id: string, at: Date) {
  const boss = await getBoss();
  const jobId = await boss.send(QUEUES.alarm, { alarmId: id }, { startAfter: at, retryLimit: 1, retryDelay: 20 });
  await query("UPDATE alarms SET job_id = $2, ring_at = $3 WHERE id = $1", [id, jobId, at]);
}

export async function createAlarm(opts: { userId: string; conversationId?: string | null; label: string; at: Date; call?: boolean }) {
  const label = opts.label.trim().replace(/\s+/g, " ").slice(0, 120) || "Alarme";
  if (Number.isNaN(opts.at.getTime())) throw new Error("Horário inválido");
  if (opts.at.getTime() < Date.now() - 60_000) throw new Error("Esse horário já passou");
  if (opts.at.getTime() > Date.now() + 366 * 86400_000) throw new Error("Alarme pode ser no máximo daqui a um ano");
  const active = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM alarms WHERE user_id = $1 AND status = 'scheduled'", [opts.userId]);
  if ((active?.n ?? 0) >= MAX_ACTIVE_ALARMS) throw new Error(`Já são ${MAX_ACTIVE_ALARMS} alarmes ativos. Cancele algum antes.`);
  const at = new Date(Math.max(opts.at.getTime(), Date.now() + 1000));
  const row = await one<{ id: string }>("INSERT INTO alarms (user_id, conversation_id, label, ring_at, call) VALUES ($1, $2, $3, $4, $5) RETURNING id", [
    opts.userId,
    opts.conversationId ?? null,
    label,
    at,
    Boolean(opts.call),
  ]);
  await enqueue(row!.id, at);
  const devices = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = $1", [opts.userId]);
  return { id: row!.id, label, ringAt: at, devices: devices?.n ?? 0 };
}

/** Agendados e os que tocaram na última hora (a tela do alarme mostra Parar/Soneca para esses). */
export async function listAlarms(userId: string) {
  return many<{ id: string; label: string; ring_at: string; status: string; snoozes: number; fired_at: string | null }>(
    `SELECT id, label, ring_at, status, snoozes, fired_at FROM alarms
      WHERE user_id = $1 AND (status = 'scheduled' OR (status = 'rang' AND fired_at > now() - interval '1 hour'))
      ORDER BY ring_at ASC LIMIT 50`,
    [userId],
  );
}

export async function cancelAlarm(id: string, userId: string) {
  const r = await one("UPDATE alarms SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = 'scheduled' RETURNING job_id", [id, userId]);
  if (!r) return false;
  if (r.job_id) await (await getBoss()).cancel(QUEUES.alarm, r.job_id).catch(() => {});
  return true;
}

/** Parar: o que tocou fica parado; se estava em soneca, a soneca é cancelada. */
export async function stopAlarm(id: string, userId?: string) {
  const r = await one(
    `UPDATE alarms SET status = 'stopped' WHERE id = $1 AND status IN ('rang', 'scheduled') AND (status = 'rang' OR snoozes > 0)
       ${userId ? "AND user_id = $2" : ""} RETURNING job_id, status`,
    userId ? [id, userId] : [id],
  );
  if (r?.job_id) await (await getBoss()).cancel(QUEUES.alarm, r.job_id).catch(() => {});
  return Boolean(r);
}

export async function snoozeAlarm(id: string, userId?: string, minutes = 5) {
  const r = await one(
    `UPDATE alarms SET status = 'scheduled', snoozes = snoozes + 1 WHERE id = $1 AND status = 'rang' AND snoozes < $2
       ${userId ? "AND user_id = $3" : ""} RETURNING id`,
    userId ? [id, MAX_SNOOZES, userId] : [id, MAX_SNOOZES],
  );
  if (!r) return null;
  const at = new Date(Date.now() + minutes * 60_000);
  await enqueue(id, at);
  return at;
}

/** Na hora: notificação em todos os aparelhos, ligação se for o caso e "Alarme: ..." no WhatsApp (só no primeiro toque). */
export async function ringAlarm(id: string) {
  const a = await one(
    `UPDATE alarms SET status = 'rang', fired_at = now() WHERE id = $1 AND status = 'scheduled' AND ring_at <= now() + interval '10 seconds'
     RETURNING id, user_id, conversation_id, label, ring_at, snoozes, call`,
    [id],
  );
  if (!a) return null;
  const user = await one("SELECT id, phone FROM users WHERE id = $1", [a.user_id]);
  const tracer = await Tracer.start({ trigger: "alarm", userId: a.user_id, conversationId: a.conversation_id, input: `Alarme: ${a.label}` });
  const out: Record<string, unknown> = {};
  try {
    const mode = await getAlarmMode(a.user_id);
    const push = await tracer.step({ agent: "agenda", type: "tool", name: "alarme: notificação", input: { label: a.label, soneca: a.snoozes } });
    try {
      out.push = await sendPush(a.user_id, { type: "alarm", id: a.id, label: a.label, at: new Date(a.ring_at).toISOString(), token: alarmActionToken(a.id), snoozes: a.snoozes });
      await push.ok(out.push);
    } catch (err) {
      await push.fail(err);
    }
    // liga se a pessoa escolheu ligação para todos os alarmes ou pediu ligação neste
    if ((a.call || mode !== "push") && user && (await twilioReady())) {
      // custo da ligação não vem na resposta do Twilio: fica 0 aqui e o registro mostra o sid para conferir
      const call = await tracer.step({ agent: "agenda", type: "tool", name: "alarme: ligação", input: { label: a.label, custo_estimado: "desconhecido" } });
      try {
        out.call = await placeAlarmCall(a.user_id, user.phone, a.label, a.id);
        await call.ok(out.call, { costUsd: 0 });
      } catch (err) {
        out.call = { ok: false, error: (err as Error).message };
        await call.fail(err);
      }
    }
    if (a.snoozes === 0 && user) {
      const wa = await tracer.step({ agent: "agenda", type: "channel", name: "alarme: whatsapp", input: { text: `Alarme: ${a.label}` } });
      try {
        const { notifyUser } = await import("./social.js");
        await notifyUser(a.user_id, `Alarme: ${a.label}`);
        await wa.ok({ sent: true });
      } catch (err) {
        await wa.fail(err);
      }
    }
    await tracer.finish(`Alarme: ${a.label}`);
  } catch (err) {
    await tracer.error(err);
  }
  // o que já passou há mais de uma semana não fica guardado
  await query("DELETE FROM alarms WHERE user_id = $1 AND status <> 'scheduled' AND created_at < now() - interval '7 days'", [a.user_id]).catch(() => {});
  return out;
}

/** Teste pela tela: notificação agora (e ligação se pedida), sem criar alarme nem mandar WhatsApp. */
export async function testAlarm(userId: string, opts: { call?: boolean } = {}) {
  const label = "Teste de alarme";
  const push = await sendPush(userId, { type: "alarm", id: null, label, at: new Date().toISOString(), test: true }, { ttl: 120 });
  let call: unknown = null;
  if (opts.call) {
    const u = await one("SELECT phone FROM users WHERE id = $1", [userId]);
    const tracer = await Tracer.start({ trigger: "alarm", userId, input: label });
    const step = await tracer.step({ agent: "agenda", type: "tool", name: "alarme: ligação (teste)", input: { custo_estimado: "desconhecido" } });
    try {
      call = await placeAlarmCall(userId, u?.phone ?? "", label, null);
      await step.ok(call, { costUsd: 0 });
      await tracer.finish(label);
    } catch (err) {
      call = { ok: false, error: (err as Error).message };
      await step.fail(err);
      await tracer.error(err);
    }
  }
  return { push, call };
}

/**
 * Lembrete com ligação: na hora liga e fala o texto curto que a pessoa pediu, além da mensagem no WhatsApp.
 * O job do lembrete pode repetir (erro do LLM): uma ligação por lembrete a cada 10 min.
 */
export async function callForReminder(r: { id: string; user_id: string; conversation_id: string | null; call_text: string | null }) {
  if (!r.call_text || !(await twilioReady())) return null;
  const done = await one("SELECT 1 FROM alarm_calls WHERE reminder_id = $1 AND created_at > now() - interval '10 minutes'", [r.id]);
  if (done) return { ok: false, skipped: "já ligou" };
  const user = await one("SELECT phone FROM users WHERE id = $1", [r.user_id]);
  if (!user) return null;
  const tracer = await Tracer.start({ trigger: "reminder", userId: r.user_id, conversationId: r.conversation_id, input: `Ligação: ${r.call_text}` });
  const step = await tracer.step({ agent: "agenda", type: "tool", name: "lembrete: ligação", input: { texto: r.call_text, custo_estimado: "desconhecido" } });
  try {
    const out = await placeAlarmCall(r.user_id, user.phone, r.call_text, null, { reminderId: r.id, prefix: "Lembrete do Planejai" });
    await step.ok(out, { costUsd: 0 });
    await tracer.finish(`Ligação: ${r.call_text}`);
    return out;
  } catch (err) {
    await step.fail(err);
    await tracer.error(err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function startAlarmWorker(boss: PgBoss) {
  await boss.work<{ alarmId: string }>(QUEUES.alarm, { batchSize: 1, pollingIntervalSeconds: 1 }, async ([job]) => {
    if (job) await ringAlarm(job.data.alarmId);
  });
}
