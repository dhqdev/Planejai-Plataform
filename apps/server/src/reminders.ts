import cronParser from "cron-parser";
import { many, one, query } from "./db/pool.js";
import { QUEUES, getBoss } from "./queue/boss.js";

export function nextCronDate(cron: string, timezone: string, after = new Date()): Date {
  return cronParser.parseExpression(cron, { tz: timezone, currentDate: after }).next().toDate();
}

async function enqueue(reminderId: string, at: Date) {
  const boss = await getBoss();
  const jobId = await boss.send(QUEUES.reminder, { reminderId }, { startAfter: at, retryLimit: 2 });
  await query("UPDATE reminders SET job_id = $2, due_at = $3 WHERE id = $1", [reminderId, jobId, at]);
}

export async function createReminder(opts: {
  userId: string;
  conversationId: string;
  intent: string;
  dueAt?: Date | null;
  cron?: string | null;
  timezone: string;
}) {
  if (!opts.dueAt && !opts.cron) throw new Error("Informe due_at ou cron");
  if (opts.cron) nextCronDate(opts.cron, opts.timezone); // valida a expressão
  const first = opts.dueAt ?? nextCronDate(opts.cron!, opts.timezone);
  if (first.getTime() < Date.now() - 60_000) throw new Error(`O horário ${first.toISOString()} já passou`);
  const row = await one<{ id: string }>(
    `INSERT INTO reminders (user_id, conversation_id, intent, due_at, cron, timezone) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [opts.userId, opts.conversationId, opts.intent, first, opts.cron ?? null, opts.timezone],
  );
  await enqueue(row!.id, first);
  return { id: row!.id, dueAt: first, cron: opts.cron ?? null };
}

export async function cancelReminder(id: string, userId?: string) {
  const r = await one(
    `UPDATE reminders SET status = 'cancelled' WHERE id = $1 AND status = 'scheduled' ${userId ? "AND user_id = $2" : ""} RETURNING job_id`,
    userId ? [id, userId] : [id],
  );
  if (!r) return false;
  if (r.job_id) await (await getBoss()).cancel(QUEUES.reminder, r.job_id).catch(() => {});
  return true;
}

export async function listReminders(userId?: string) {
  return many(
    `SELECT r.id, r.intent, r.due_at, r.cron, r.timezone, r.status, r.last_fired_at, r.created_at, u.name AS user_name, u.phone
       FROM reminders r JOIN users u ON u.id = r.user_id
      WHERE ($1::uuid IS NULL OR r.user_id = $1) AND (r.status = 'scheduled' OR r.created_at > now() - interval '30 days')
      ORDER BY (r.status = 'scheduled') DESC, r.due_at ASC NULLS LAST LIMIT 200`,
    [userId ?? null],
  );
}

/**
 * Depois de disparar: lembrete recorrente agenda o próximo. O único que deu certo é apagado de vez,
 * junto com o que o agente tiver guardado sobre ele na memória: lembrete que passou não fica ocupando contexto.
 */
export async function afterFire(id: string, ok: boolean) {
  const r = await one("SELECT user_id, intent, cron, timezone, status, created_at FROM reminders WHERE id = $1", [id]);
  if (!r || r.status !== "scheduled") return;
  if (r.cron) {
    await query("UPDATE reminders SET last_fired_at = now() WHERE id = $1", [id]);
    await enqueue(id, nextCronDate(r.cron, r.timezone));
  } else if (ok) {
    await forgetReminder(r);
    await query("DELETE FROM reminders WHERE id = $1", [id]);
  } else {
    await query("UPDATE reminders SET status = 'failed', last_fired_at = now() WHERE id = $1", [id]);
  }
}

/** Apaga memórias criadas junto com o lembrete (até 10 min antes/depois) que falam do mesmo assunto. */
async function forgetReminder(r: { user_id: string; intent: string; created_at: Date }) {
  const words = [...new Set(r.intent.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/[a-z]{4,}/g) ?? [])]
    .filter((w) => !STOP.has(w))
    .slice(0, 12);
  await query(
    `DELETE FROM memories
      WHERE user_id = $1
        AND created_at BETWEEN $2::timestamptz - interval '10 minutes' AND $2::timestamptz + interval '10 minutes'
        AND ('lembrete' = ANY(tags) OR content ILIKE '%lembr%' OR ($3 <> '' AND search @@ to_tsquery('portuguese', $3)))`,
    [r.user_id, r.created_at, words.join(" | ")],
  );
}
const STOP = new Set(["lembrar", "lembrete", "pediu", "minutos", "horas", "hoje", "amanha", "depois", "para", "pela", "pelo", "dele", "dela", "sobre", "agora", "quando", "esta", "isso"]);
