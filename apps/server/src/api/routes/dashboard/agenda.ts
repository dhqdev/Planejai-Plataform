import type { FastifyInstance } from "fastify";
import { config } from "../../../config.js";
import { one } from "../../../db/pool.js";
import { googleApi } from "../../../integrations/google.js";
import { isConnected } from "../../../integrations/registry.js";
import { cancelReminder, createReminder, listReminders, reminderOccurrences, rescheduleReminder } from "../../../reminders.js";
import { NOBODY, personalUser, selfUserId } from "../../../sharing.js";
import { parseLocalDateTime } from "../../../time.js";
import { cancelWatch, listWatches } from "../../../watches.js";

/**
 * Agenda: lembretes, calendário (com o Google Agenda do dono) e acompanhamentos. Particular como Finanças:
 * cada um vê a própria; a de outra pessoa só se ela compartilhou (?user=), e só para ver.
 */
export function agendaRoutes(base: FastifyInstance) {
  const self = async (a: Parameters<typeof selfUserId>[0]) => (await selfUserId(a)) ?? NOBODY;
  // ---------- Lembretes ----------
  base.get("/api/reminders", async (req) => listReminders(await self(req.account)));
  base.delete<{ Params: { id: string } }>("/api/reminders/:id", async (req) => ({ ok: await cancelReminder(req.params.id, await self(req.account)) }));

  // novo lembrete pelo painel (calendário): vai para a conversa mais recente da própria pessoa
  base.post<{ Body: { intent?: string; at?: string } }>("/api/reminders", async (req, reply) => {
    const uid = await selfUserId(req.account);
    const intent = String(req.body.intent ?? "").trim();
    if (!uid) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil para criar lembretes" });
    if (!intent) return reply.code(400).send({ error: "Diga o que lembrar" });
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(req.body.at ?? "")) return reply.code(400).send({ error: "Data e hora inválidas" });
    const u = await one("SELECT id, timezone FROM users WHERE id = $1", [uid]);
    const conv = u && (await one("SELECT id FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1", [uid]));
    if (!conv) return reply.code(400).send({ error: "Mande um oi no WhatsApp do assistente antes de criar o primeiro lembrete" });
    const tz = u.timezone ?? config.DEFAULT_TIMEZONE;
    try {
      return await createReminder({ userId: uid, conversationId: conv.id, intent: `${intent} (criado pelo painel)`, dueAt: parseLocalDateTime(req.body.at!, tz), timezone: tz });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  base.patch<{ Params: { id: string }; Body: { at?: string } }>("/api/reminders/:id", async (req, reply) => {
    const at = req.body.at ? new Date(req.body.at) : null;
    if (!at || Number.isNaN(at.getTime())) return reply.code(400).send({ error: "Data inválida" });
    try {
      return { ok: await rescheduleReminder(req.params.id, at, await self(req.account)) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // ---------- Agenda (calendário): lembretes + Google Agenda conectado (só o dono vê) ----------
  base.get<{ Querystring: { from?: string; to?: string; user?: string } }>("/api/calendar", async (req, reply) => {
    const from = new Date(req.query.from ?? "");
    const to = new Date(req.query.to ?? "");
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > 100 * 86400_000)
      return reply.code(400).send({ error: "Período inválido" });
    const uid = await personalUser(req.account, req.query.user, "agenda");
    if (!uid) return reply.code(403).send({ error: "Essa pessoa não compartilhou a agenda com você" });
    const mine = uid === (await self(req.account));
    const events: any[] = (await reminderOccurrences(from, to, uid)).map((e) => ({ ...e, kind: "reminder" }));
    if (req.account.owner && mine && (await isConnected("google").catch(() => false))) {
      try {
        const params = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250" });
        const j = await googleApi(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
        for (const e of j.items ?? []) {
          const allDay = !e.start?.dateTime;
          events.push({
            id: `g:${e.id}`,
            kind: "google",
            title: e.summary ?? "(sem título)",
            start: allDay ? `${e.start.date}T00:00:00` : e.start.dateTime,
            end: allDay ? null : e.end?.dateTime ?? null,
            allDay,
            location: e.location ?? null,
            link: e.htmlLink ?? null,
          });
        }
      } catch {
        /* Google fora do ar: mostra só os lembretes */
      }
    }
    return { events, readonly: !mine };
  });

  // ---------- Acompanhamentos (o agente fica de olho e avisa sozinho) ----------
  base.get("/api/watches", async (req) => listWatches(await self(req.account)));
  base.delete<{ Params: { id: string } }>("/api/watches/:id", async (req) => ({ ok: await cancelWatch(req.params.id, await self(req.account)) }));
}
