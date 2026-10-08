import cronParser from "cron-parser";
import { many, one, query } from "./db/pool.js";
import { QUEUES, getBoss } from "./queue/boss.js";
import { cronTooFrequent } from "./cron-limits.js";
import { formatLocal } from "./time.js";

/** Lembrete recorrente dispara no máximo a cada 15 min: cada disparo roda o CTO inteiro. */
export const MIN_REMINDER_INTERVAL_MIN = 15;
/** Lembretes ativos por pessoa */
export const MAX_ACTIVE_REMINDERS = 30;

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
  /** título curto para a agenda (o intent continua sendo o contexto do disparo) */
  title?: string | null;
  /** horário do compromisso, quando o aviso sai antes dele (o bloco da agenda fica aqui) */
  eventAt?: Date | null;
  tag?: string | null;
  color?: string | null;
}) {
  if (!opts.dueAt && !opts.cron) throw new Error("Informe due_at ou cron");
  if (opts.cron) {
    nextCronDate(opts.cron, opts.timezone); // valida a expressão
    if (cronTooFrequent(opts.cron, MIN_REMINDER_INTERVAL_MIN))
      throw new Error(`Lembrete recorrente pode repetir no máximo a cada ${MIN_REMINDER_INTERVAL_MIN} minutos`);
  }
  const first = opts.dueAt ?? nextCronDate(opts.cron!, opts.timezone);
  if (first.getTime() < Date.now() - 60_000) throw new Error(`O horário ${formatLocal(first, opts.timezone)} já passou`);
  const active = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM reminders WHERE user_id = $1 AND status = 'scheduled'", [opts.userId]);
  if ((active?.n ?? 0) >= MAX_ACTIVE_REMINDERS) throw new Error(`Já são ${MAX_ACTIVE_REMINDERS} lembretes ativos. Peça para cancelar algum antes de criar outro.`);
  const row = await one<{ id: string }>(
    `INSERT INTO reminders (user_id, conversation_id, intent, due_at, cron, timezone, title, event_at, tag, color)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      opts.userId,
      opts.conversationId,
      opts.intent,
      first,
      opts.cron ?? null,
      opts.timezone,
      opts.title?.trim().slice(0, 80) || null,
      opts.cron ? null : opts.eventAt ?? null,
      opts.tag ?? null,
      opts.color ?? null,
    ],
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

/**
 * Muda o horário de um lembrete único (arrastar no calendário). `at` é o horário que aparece na agenda: o do
 * compromisso quando ele tem um; o aviso anda junto, com a mesma antecedência.
 */
export async function rescheduleReminder(id: string, at: Date, userId?: string) {
  if (at.getTime() < Date.now() - 60_000) throw new Error("Esse horário já passou");
  const r = await one(
    `SELECT job_id, cron, due_at, event_at FROM reminders WHERE id = $1 AND status = 'scheduled' ${userId ? "AND user_id = $2" : ""}`,
    userId ? [id, userId] : [id],
  );
  if (!r) return false;
  if (r.cron) throw new Error("Lembrete recorrente: peça a mudança no WhatsApp");
  const lead = r.event_at ? Math.max(0, new Date(r.event_at).getTime() - new Date(r.due_at).getTime()) : 0;
  const due = new Date(Math.max(at.getTime() - lead, Date.now() + 5_000));
  if (r.job_id) await (await getBoss()).cancel(QUEUES.reminder, r.job_id).catch(() => {});
  await enqueue(id, due);
  if (r.event_at) await query("UPDATE reminders SET event_at = $2 WHERE id = $1", [id, at]);
  return true;
}

/** Troca título, tag ou cor de um compromisso (tela da agenda). */
export async function updateReminderLook(id: string, userId: string, look: { title?: string | null; tag?: string | null; color?: string | null }) {
  const sets: string[] = [];
  const vals: unknown[] = [id, userId];
  for (const [col, v] of Object.entries(look)) {
    if (v === undefined) continue;
    vals.push(v === null ? null : col === "title" ? String(v).trim().slice(0, 80) || null : v);
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return true;
  const r = await one(`UPDATE reminders SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 AND status = 'scheduled' RETURNING id`, vals);
  return Boolean(r);
}

/**
 * Ocorrências dos lembretes agendados entre duas datas, para o calendário.
 * Recorrentes são expandidos pelo cron (no máximo 400 no período).
 */
export async function reminderOccurrences(from: Date, to: Date, userId?: string | null) {
  const rows = await many(
    `SELECT r.id, r.intent, r.title, r.tag, r.color, r.due_at, r.event_at, r.cron, r.timezone, u.name AS user_name, u.phone
       FROM reminders r JOIN users u ON u.id = r.user_id
      WHERE r.status = 'scheduled' AND ($1::uuid IS NULL OR r.user_id = $1)
        AND (r.cron IS NOT NULL OR COALESCE(r.event_at, r.due_at) BETWEEN $2 AND $3)`,
    [userId ?? null, from, to],
  );
  type Occ = {
    id: string;
    reminderId: string;
    title: string;
    intent: string;
    start: string;
    end?: string;
    remindAt?: string;
    tag: string | null;
    color: string | null;
    recurring: boolean;
    person: string | null;
  };
  const out: Occ[] = [];
  for (const r of rows) {
    const base = {
      reminderId: r.id,
      title: r.title || r.intent,
      intent: r.intent,
      tag: r.tag,
      color: r.color,
      recurring: Boolean(r.cron),
      person: r.user_name ?? (r.phone ? `+${r.phone}` : null),
    };
    if (!r.cron) {
      // compromisso: o bloco fica no horário dele (1h) e o aviso aparece no detalhe
      if (r.event_at) {
        const s = new Date(r.event_at);
        out.push({ ...base, id: r.id, start: s.toISOString(), end: new Date(s.getTime() + 3600_000).toISOString(), remindAt: new Date(r.due_at).toISOString() });
      } else out.push({ ...base, id: r.id, start: new Date(r.due_at).toISOString() });
      continue;
    }
    try {
      const it = cronParser.parseExpression(r.cron, { tz: r.timezone, currentDate: new Date(Math.max(from.getTime(), Date.now()) - 1000), endDate: to });
      for (let n = 0; n < 400 && it.hasNext(); n++) {
        const d = it.next().toDate();
        out.push({ ...base, id: `${r.id}:${d.getTime()}`, start: d.toISOString() });
      }
    } catch {
      /* cron inválido: ignora */
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

export async function listReminders(userId?: string) {
  return many(
    `SELECT r.id, r.intent, r.title, r.tag, r.color, r.due_at, r.event_at, r.cron, r.timezone, r.status, r.last_fired_at, r.created_at, u.name AS user_name, u.phone
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
