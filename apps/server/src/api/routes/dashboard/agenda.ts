import type { FastifyInstance } from "fastify";
import { config } from "../../../config.js";
import { many, one } from "../../../db/pool.js";
import { attachmentLabel, cancelDirect, hideDirect, rescheduleDirect } from "../../../direct.js";
import { googleApi } from "../../../integrations/google.js";
import { asPerson } from "../../../integrations/person.js";
import { isConnected } from "../../../integrations/registry.js";
import { isColor, listTags, resolveTag } from "../../../agenda-tags.js";
import { cancelReminder, createReminder, listReminders, reminderOccurrences, retimeReminder, updateReminderLook } from "../../../reminders.js";
import { NOBODY, personalUsers, selfUserId, sharedWithMe } from "../../../sharing.js";
import { parseLocalDateTime } from "../../../time.js";
import { conversationOf } from "../../../social.js";
import { checkWatchNow, createWatch, listWatches, removeWatch, updateWatch, type NotifyMode } from "../../../watches.js";

/**
 * Agenda: lembretes, calendário (com o Google Agenda do dono) e acompanhamentos. Particular como Finanças:
 * cada um vê a própria; a de outra pessoa só se ela compartilhou (?user=), e só para ver.
 */
export function agendaRoutes(base: FastifyInstance) {
  const self = async (a: Parameters<typeof selfUserId>[0]) => (await selfUserId(a)) ?? NOBODY;
  // ---------- Lembretes ----------
  base.get("/api/reminders", async (req) => listReminders(await self(req.account)));
  base.delete<{ Params: { id: string } }>("/api/reminders/:id", async (req, reply) =>
    (await cancelReminder(req.params.id, await self(req.account))) ? { ok: true } : reply.code(404).send({ error: "Esse lembrete já foi enviado ou excluído." }),
  );

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

  // editar pela agenda: horário (at, o do compromisso), antecedência do aviso (before_min), título, detalhes, tag e cor
  base.patch<{
    Params: { id: string };
    Body: { at?: string; before_min?: number | null; title?: string; intent?: string; tag?: string | null; color?: string };
  }>("/api/reminders/:id", async (req, reply) => {
    const b = req.body ?? {};
    const me = await self(req.account);
    const at = b.at ? new Date(b.at) : undefined;
    if (at && Number.isNaN(at.getTime())) return reply.code(400).send({ error: "Data inválida" });
    if (b.before_min != null && (typeof b.before_min !== "number" || !Number.isFinite(b.before_min) || b.before_min < 0))
      return reply.code(400).send({ error: "Antecedência inválida" });
    if (b.intent !== undefined && !String(b.intent).trim()) return reply.code(400).send({ error: "Diga o que lembrar" });
    if (b.title !== undefined || b.intent !== undefined || b.tag !== undefined || b.color !== undefined) {
      if (b.color !== undefined && !isColor(b.color)) return reply.code(400).send({ error: "Cor inválida" });
      const tag = b.tag ? await resolveTag(me, b.tag, "", { color: b.color, exact: true }) : null;
      if (b.tag && !tag) return reply.code(400).send({ error: "Limite de tags atingido" });
      const ok = await updateReminderLook(req.params.id, me, {
        title: b.title,
        intent: b.intent,
        tag: b.tag === undefined ? undefined : tag?.name ?? null,
        // trocar a tag leva a cor dela, a não ser que a cor também tenha vindo
        color: b.color ?? (b.tag === undefined ? undefined : tag?.color ?? null),
      });
      if (!ok) return reply.code(404).send({ error: "Lembrete não encontrado ou já enviado" });
    }
    if (!at && b.before_min == null) return { ok: true };
    try {
      const r = await retimeReminder(req.params.id, me, { at, beforeMin: b.before_min ?? undefined });
      return r ? { ok: true, ...r } : reply.code(404).send({ error: "Lembrete não encontrado ou já enviado" });
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
    const uids = await personalUsers(req.account, req.query.user, "agenda");
    if (!uids || !uids.length) return reply.code(403).send({ error: "Essa pessoa não compartilhou a agenda com você" });
    const me = await self(req.account);
    const mineOnly = uids.length === 1 && uids[0] === me;
    const readonly = !mineOnly;
    const sharedList = await sharedWithMe(me, "agenda");
    const nameMap = new Map<string, string>(sharedList.map((s) => [s.id, s.name]));
    nameMap.set(me, "Minha agenda");

    const events: any[] = [];
    for (const uid of uids) {
      const occs = await reminderOccurrences(from, to, uid);
      for (const e of occs) {
        events.push({
          ...e,
          kind: "reminder",
          ownerId: uid,
          ownerName: uid === me ? undefined : (nameMap.get(uid) ?? undefined),
        });
      }
    }

    // Google Agenda só na própria agenda: o dono vê a da plataforma, o cliente a que ele conectou em Minha conta
    const person = { userId: me, owner: req.account.owner };
    if (uids.includes(me) && (await asPerson(person, () => isConnected("google")).catch(() => false))) {
      try {
        const params = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250" });
        const j = await asPerson(person, () => googleApi(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`));
        // evento que o próprio Planejai mandou para o Google já aparece como lembrete: não duplica
        const mirrored = new Set(events.map((e) => e.reminderId));
        for (const e of j.items ?? []) {
          if (mirrored.has(e.extendedProperties?.private?.planejai)) continue;
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
    // mensagens avulsas agendadas (send_whatsapp): aparecem na hora em que saem, só na própria agenda
    if (uids.includes(me)) {
      const msgs = await many(
        `SELECT id, name, phone, text, send_at, status, media_kind, media_name FROM direct_messages
          WHERE user_id = $1 AND status IN ('scheduled', 'sending', 'sent', 'failed') AND NOT hidden AND send_at >= $2 AND send_at < $3
            AND (status = 'scheduled' OR created_at < send_at - interval '1 minute')
          ORDER BY send_at LIMIT 200`,
        [me, from, to],
      );
      for (const m of msgs) {
        const who = m.name || `+${m.phone}`;
        events.push({ id: `m:${m.id}`, kind: "message", directId: m.id, title: `Mensagem para ${who}`, start: new Date(m.send_at).toISOString(), person: who, intent: m.media_kind ? `${m.text} (📎 ${attachmentLabel({ kind: m.media_kind, name: m.media_name })})` : m.text, status: m.status });
      }
    }
    return { events, readonly, tags: await listTags(uids[0] ?? me) };
  });

  // cancelar uma mensagem avulsa agendada pela agenda (não manda nada)
  base.delete<{ Params: { id: string } }>("/api/direct/:id", async (req, reply) => {
    const me = await self(req.account);
    // agendada: cancela (não sai); já enviada ou falhou: só some da agenda
    const r = (await cancelDirect(me, req.params.id)).ok ? { ok: true } : await hideDirect(me, req.params.id);
    return r.ok ? r : reply.code(404).send({ error: r.error });
  });

  // mensagem agendada: só muda o dia e a hora (o texto foi o que a pessoa aprovou com o "sim")
  base.patch<{ Params: { id: string }; Body: { at?: string } }>("/api/direct/:id", async (req, reply) => {
    const at = new Date(req.body?.at ?? "");
    if (Number.isNaN(at.getTime())) return reply.code(400).send({ error: "Data inválida" });
    const r = await rescheduleDirect(await self(req.account), req.params.id, at);
    return r.ok ? r : reply.code(400).send({ error: r.error });
  });

  // evento do Google Agenda da própria pessoa: editar e excluir pela agenda do painel
  const googleEvent = async (req: { account: Parameters<typeof selfUserId>[0] }, id: string, init: RequestInit) => {
    const person = { userId: await self(req.account), owner: req.account.owner };
    if (!(await asPerson(person, () => isConnected("google")).catch(() => false))) throw new Error("Google Agenda não está conectado");
    return asPerson(person, () =>
      googleApi(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`, { ...init, signal: AbortSignal.timeout(10_000) }),
    );
  };
  base.patch<{ Params: { id: string }; Body: { title?: string; date?: string; start?: string; end?: string; allDay?: boolean; location?: string } }>(
    "/api/calendar/google/:id",
    async (req, reply) => {
      const b = req.body ?? {};
      const body: Record<string, unknown> = {};
      if (b.title !== undefined) {
        if (!b.title.trim()) return reply.code(400).send({ error: "Dê um nome ao evento" });
        body.summary = b.title.trim().slice(0, 200);
      }
      if (b.location !== undefined) body.location = b.location.trim().slice(0, 300);
      if (b.allDay) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date ?? "")) return reply.code(400).send({ error: "Data inválida" });
        const next = new Date(`${b.date}T12:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        body.start = { date: b.date };
        body.end = { date: next.toISOString().slice(0, 10) };
      } else if (b.start !== undefined) {
        const start = new Date(b.start);
        const end = new Date(b.end ?? "");
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return reply.code(400).send({ error: "Data inválida" });
        if (end <= start) return reply.code(400).send({ error: "O fim tem que ser depois do começo" });
        body.start = { dateTime: start.toISOString() };
        body.end = { dateTime: end.toISOString() };
      }
      try {
        await googleEvent(req, req.params.id, { method: "PATCH", body: JSON.stringify(body) });
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: `Não deu para salvar no Google: ${(err as Error).message.slice(0, 200)}` });
      }
    },
  );
  base.delete<{ Params: { id: string } }>("/api/calendar/google/:id", async (req, reply) => {
    try {
      await googleEvent(req, req.params.id, { method: "DELETE" });
      return { ok: true };
    } catch (err) {
      if (/Google API 410|Google API 404/.test((err as Error).message)) return { ok: true };
      return reply.code(400).send({ error: `Não deu para excluir no Google: ${(err as Error).message.slice(0, 200)}` });
    }
  });

  // ---------- Acompanhamentos (o agente fica de olho e avisa sozinho) ----------
  base.get("/api/watches", async (req) => listWatches(await self(req.account)));
  base.delete<{ Params: { id: string } }>("/api/watches/:id", async (req) => ({ ok: await removeWatch(req.params.id, await self(req.account)) }));
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
