import type { FastifyInstance } from "fastify";
import { config } from "../../../config.js";
import { one } from "../../../db/pool.js";
import { googleApi } from "../../../integrations/google.js";
import { asPerson } from "../../../integrations/person.js";
import { isConnected } from "../../../integrations/registry.js";
import { isColor, listTags, resolveTag } from "../../../agenda-tags.js";
import { cancelReminder, createReminder, listReminders, reminderOccurrences, rescheduleReminder, updateReminderLook } from "../../../reminders.js";
import { NOBODY, personalUser, selfUserId } from "../../../sharing.js";
import { parseLocalDateTime } from "../../../time.js";
import { conversationOf } from "../../../social.js";
import { cancelWatch, checkWatchNow, createWatch, listWatches, updateWatch, type NotifyMode } from "../../../watches.js";

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
  base.post<{ Body: { intent?: string; at?: string; tag?: string; color?: string } }>("/api/reminders", async (req, reply) => {
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
      // tag escolhida na tela fica com o nome escrito; sem tag, tenta o assunto pelo texto
      const tag = await resolveTag(uid, req.body.tag, intent, { color: req.body.color, exact: Boolean(req.body.tag?.trim()) });
      return await createReminder({
        userId: uid,
        conversationId: conv.id,
        intent: `${intent} (criado pelo painel)`,
        dueAt: parseLocalDateTime(req.body.at!, tz),
        timezone: tz,
        title: intent.length <= 80 ? intent : null,
        tag: tag?.name,
        color: isColor(req.body.color) ? req.body.color : tag?.color,
      });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // mover (at) ou trocar título, tag e cor
  base.patch<{ Params: { id: string }; Body: { at?: string; title?: string; tag?: string | null; color?: string } }>("/api/reminders/:id", async (req, reply) => {
    const b = req.body ?? {};
    const me = await self(req.account);
    if (b.title !== undefined || b.tag !== undefined || b.color !== undefined) {
      if (b.color !== undefined && !isColor(b.color)) return reply.code(400).send({ error: "Cor inválida" });
      const tag = b.tag ? await resolveTag(me, b.tag, "", { color: b.color, exact: true }) : null;
      if (b.tag && !tag) return reply.code(400).send({ error: "Limite de tags atingido" });
      const ok = await updateReminderLook(req.params.id, me, {
        title: b.title,
        tag: b.tag === undefined ? undefined : tag?.name ?? null,
        // trocar a tag leva a cor dela, a não ser que a cor também tenha vindo
        color: b.color ?? (b.tag === undefined ? undefined : tag?.color ?? null),
      });
      if (!ok) return reply.code(404).send({ error: "Lembrete não encontrado ou já enviado" });
      if (!b.at) return { ok };
    }
    const at = b.at ? new Date(b.at) : null;
    if (!at || Number.isNaN(at.getTime())) return reply.code(400).send({ error: "Data inválida" });
    try {
      return { ok: await rescheduleReminder(req.params.id, at, me) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // ---------- Agenda (calendário): lembretes + Google Agenda conectado (de cada um, só na própria agenda) ----------
  base.get<{ Querystring: { from?: string; to?: string; user?: string } }>("/api/calendar", async (req, reply) => {
    const from = new Date(req.query.from ?? "");
    const to = new Date(req.query.to ?? "");
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > 100 * 86400_000)
      return reply.code(400).send({ error: "Período inválido" });
    const uid = await personalUser(req.account, req.query.user, "agenda");
    if (!uid) return reply.code(403).send({ error: "Essa pessoa não compartilhou a agenda com você" });
    const mine = uid === (await self(req.account));
    const events: any[] = (await reminderOccurrences(from, to, uid)).map((e) => ({ ...e, kind: "reminder" }));
    // Google Agenda só na própria agenda: o dono vê a da plataforma, o cliente a que ele conectou em Minha conta
    const person = { userId: uid, owner: req.account.owner };
    if (mine && (await asPerson(person, () => isConnected("google")).catch(() => false))) {
      try {
        const params = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250" });
        const j = await asPerson(person, () => googleApi(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`));
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
    return { events, readonly: !mine, tags: await listTags(uid) };
  });

  // ---------- Acompanhamentos (o agente fica de olho e avisa sozinho) ----------
  base.get("/api/watches", async (req) => listWatches(await self(req.account)));
  base.delete<{ Params: { id: string } }>("/api/watches/:id", async (req) => ({ ok: await cancelWatch(req.params.id, await self(req.account)) }));
  // criar pela tela: os avisos vão para a conversa da pessoa no WhatsApp
  base.post<{ Body: { kind?: "price" | "news"; query?: string; target?: number | null; every_hours?: number; days?: number; notify_mode?: NotifyMode } }>(
    "/api/watches",
    async (req, reply) => {
      const me = await selfUserId(req.account);
      if (!me) return reply.code(400).send({ error: "Sua conta não está ligada a um número de WhatsApp" });
      const b = req.body ?? {};
      if (!b.query?.trim()) return reply.code(400).send({ error: "Diga o que acompanhar" });
      const u = await one("SELECT id, phone FROM users WHERE id = $1", [me]);
      const { conv } = await conversationOf(u.id, u.phone);
      try {
        return await createWatch({
          userId: me,
          conversationId: conv.id,
          kind: b.kind === "price" ? "price" : "news",
          query: b.query,
          target: b.target ?? null,
          everyHours: b.every_hours,
          days: b.days,
          notifyMode: b.notify_mode,
        });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );
  base.patch<{ Params: { id: string }; Body: Parameters<typeof updateWatch>[2] }>("/api/watches/:id", async (req, reply) => {
    try {
      const w = await updateWatch(req.params.id, await self(req.account), req.body ?? {});
      return w ? { ok: true } : reply.code(404).send({ error: "Acompanhamento não encontrado" });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  base.post<{ Params: { id: string } }>("/api/watches/:id/check", async (req, reply) => {
    const r = await checkWatchNow(req.params.id, await self(req.account));
    return r ?? reply.code(404).send({ error: "Acompanhamento não encontrado ou parado" });
  });
}
