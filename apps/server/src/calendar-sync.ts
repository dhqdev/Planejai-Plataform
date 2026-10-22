import { many, one, query } from "./db/pool.js";
import { googleApi } from "./integrations/google.js";
import { asPerson } from "./integrations/person.js";
import { isConnected } from "./integrations/registry.js";

/**
 * Agenda do Planejai espelhada no Google Agenda de quem conectou a conta: lembrete único criado aqui vira evento lá,
 * mudar horário ou título muda lá, cancelar apaga lá. Recorrente fica só no Planejai. Lembrete que disparou some do
 * Planejai, mas o evento fica no Google como histórico. Google fora do ar nunca impede o lembrete.
 */
const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const gone = (err: unknown) => /Google API (404|410)/.test(String((err as Error)?.message ?? err));

/** Roda com a conta Google da pessoa (o dono usa a da plataforma); sem Google conectado devolve null. */
export async function withGoogle<T>(userId: string, fn: () => Promise<T>): Promise<T | null> {
  const u = await one<{ phone: string }>("SELECT phone FROM users WHERE id = $1", [userId]);
  if (!u) return null;
  const { isOwner } = await import("./ingest.js");
  return asPerson({ userId, owner: isOwner(u.phone) }, async () => ((await isConnected("google")) ? fn() : null));
}

interface Row {
  id: string;
  user_id: string;
  intent: string;
  title: string | null;
  due_at: Date;
  event_at: Date | null;
  event_minutes: number | null;
  timezone: string;
  cron: string | null;
  status: string;
  google_event_id: string | null;
}

function eventBody(r: Row) {
  const start = new Date(r.event_at ?? r.due_at);
  // compromisso ocupa 1h (ou a duração do agendamento), como no calendário do painel; aviso simples, 30 min
  const end = new Date(start.getTime() + (r.event_at ? (r.event_minutes ?? 60) : 30) * 60_000);
  const intent = r.intent.replace(/\s*\(criado pelo painel\)$/, "");
  return {
    summary: (r.title || intent).slice(0, 120),
    description: r.title && intent !== r.title ? `${intent}\n\nCriado no Planejai` : "Criado no Planejai",
    start: { dateTime: start.toISOString(), timeZone: r.timezone },
    end: { dateTime: end.toISOString(), timeZone: r.timezone },
    extendedProperties: { private: { planejai: r.id } },
  };
}

const send = (url: string, method: string, body?: unknown) =>
  googleApi(url, { method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });

/** Cria ou atualiza no Google o evento de um lembrete único agendado. */
export async function syncReminder(id: string) {
  const r = await one<Row>("SELECT id, user_id, intent, title, due_at, event_at, event_minutes, timezone, cron, status, google_event_id FROM reminders WHERE id = $1", [id]);
  if (!r || r.cron || r.status !== "scheduled") return null;
  return withGoogle(r.user_id, async () => {
    const body = eventBody(r);
    if (r.google_event_id) {
      try {
        await send(`${CAL}/${encodeURIComponent(r.google_event_id)}`, "PATCH", body);
        return r.google_event_id;
      } catch (err) {
        if (!gone(err)) throw err;
        // apagado lá no Google: cria de novo
      }
    }
    const e = await send(CAL, "POST", body);
    await query("UPDATE reminders SET google_event_id = $2 WHERE id = $1", [id, e.id]);
    return e.id as string;
  });
}

/** Apaga no Google o evento de um lembrete cancelado. */
export async function unsyncReminder(r: { user_id: string; google_event_id: string | null }) {
  if (!r.google_event_id) return;
  await withGoogle(r.user_id, async () => {
    await send(`${CAL}/${encodeURIComponent(r.google_event_id!)}`, "DELETE").catch((err) => {
      if (!gone(err)) throw err;
    });
  });
}

/** Nunca derruba o lembrete: só registra no log. */
export function quietly(p: Promise<unknown>) {
  return p.catch((err) => console.error("[google agenda]", (err as Error).message));
}

/** Acabou de conectar o Google: manda o que já estava agendado (dono = todos os números de dono). */
export async function syncAllFor(userIds: string[]) {
  if (!userIds.length) return;
  const rows = await many<{ id: string }>(
    `SELECT id FROM reminders WHERE user_id = ANY($1::uuid[]) AND status = 'scheduled' AND cron IS NULL AND google_event_id IS NULL ORDER BY due_at LIMIT 100`,
    [userIds],
  );
  for (const r of rows) await quietly(syncReminder(r.id));
}

export async function ownerUserIds() {
  const { isOwner } = await import("./ingest.js");
  return (await many<{ id: string; phone: string }>("SELECT id, phone FROM users")).filter((u) => isOwner(u.phone)).map((u) => u.id);
}
