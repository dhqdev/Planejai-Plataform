import { describeDirect, listDirect } from "../../direct.js";
import { googleApi } from "../../integrations/google.js";
import { resolveTag } from "../../agenda-tags.js";
import { cancelReminder, createReminder, listReminders, reminderOccurrences, rescheduleReminder } from "../../reminders.js";
import { formatLocal, parseLocalDateTime } from "../../time.js";
import { cancelAlarm, createAlarm, listAlarms } from "../../alarms.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

const hm = (d: Date, tz: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(d);
const dayOf = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);

export const scheduleReminder = defineTool<{
  intent: string;
  in_minutes?: number;
  at?: string;
  cron?: string;
  title?: string;
  event_at?: string;
  tag?: string;
}>({
  name: "schedule_reminder",
  description:
    "Lembrete ou mensagem proativa: na hora o CTO escreve a mensagem a partir do intent. in_minutes, at (data/hora) ou cron (recorrente). " +
    "Compromisso: title curto, tag do assunto e event_at se o aviso sai antes. O resultado mostra o que já tem no dia.",
  parameters: obj(
    {
      intent: {
        type: "string",
        description: "O que lembrar, com contexto (quem pediu e por quê)",
      },
      in_minutes: { type: "number" },
      at: { type: "string", description: "Hora do aviso, AAAA-MM-DDTHH:MM local" },
      cron: { type: "string", description: "5 campos, fuso da pessoa, ex.: 0 8 * * 1-5" },
      title: { type: "string", description: "Nome na agenda, 2 a 5 palavras (ex.: Veterinário do Thor)" },
      event_at: { type: "string", description: "Hora do compromisso, se diferente do aviso" },
      tag: { type: "string", description: "Assunto em 1 palavra (Saúde, Trabalho, Pet...); reaproveita as da pessoa" },
    },
    ["intent"],
  ),
  async run(args, ctx) {
    let dueAt: Date | null = null;
    if (args.in_minutes != null) dueAt = new Date(Date.now() + args.in_minutes * 60_000);
    else if (args.at) dueAt = parseLocalDateTime(args.at, ctx.timezone);
    const eventAt = args.event_at && !args.cron ? parseLocalDateTime(args.event_at, ctx.timezone) : null;
    if (!dueAt && eventAt) dueAt = eventAt;
    const tag = await resolveTag(ctx.user.id, args.tag, `${args.title ?? ""} ${args.intent}`).catch(() => null);
    const r = await createReminder({
      userId: ctx.user.id,
      conversationId: ctx.conversation.id,
      intent: args.intent,
      dueAt,
      cron: args.cron ?? null,
      timezone: ctx.timezone,
      title: args.title,
      eventAt,
      tag: tag?.name,
      color: tag?.color,
    });
    // o que já está no dia, para avisar de choque de horário sem outra chamada
    const at = eventAt ?? r.dueAt;
    const day = new Date(at.getTime() - 12 * 3600_000);
    const others = r.cron
      ? []
      : (await reminderOccurrences(day, new Date(at.getTime() + 12 * 3600_000), ctx.user.id).catch(() => []))
          .filter((o) => o.reminderId !== r.id && dayOf(new Date(o.start), ctx.timezone) === dayOf(at, ctx.timezone))
          .slice(0, 6);
    const clash = others.find((o) => Math.abs(new Date(o.start).getTime() - at.getTime()) < 3600_000);
    return {
      ok: true,
      id: r.id,
      first_fire_local: formatLocal(r.dueAt, ctx.timezone),
      ...(eventAt ? { event_local: formatLocal(eventAt, ctx.timezone) } : {}),
      recurring: Boolean(r.cron),
      tag: tag ? `${tag.name}${tag.created ? " (nova)" : ""}` : null,
      ...(others.length ? { same_day: others.map((o) => `${hm(new Date(o.start), ctx.timezone)} ${o.title.slice(0, 40)}`) } : {}),
      ...(clash ? { clash: `Choca com ${clash.title.slice(0, 40)}` } : {}),
    };
  },
});

export const listRemindersTool = defineTool<Record<string, never>>({
  name: "list_reminders",
  description: "Lista os lembretes agendados da pessoa (com id, para mudar o horário ou cancelar).",
  parameters: obj({}),
  async run(_a, ctx) {
    const rows = (await listReminders(ctx.user.id)).filter((r) => r.status === "scheduled");
    // mensagens agendadas para outra pessoa também são "o que vai acontecer": aparecem junto (cancelar com direct_cancel)
    const messages = (await listDirect(ctx.user.id)).map((d) => describeDirect(d, ctx.timezone));
    if (!rows.length && !messages.length) return { reminders: [], note: "Nenhum lembrete agendado." };
    const reminders = rows.map((r) => ({
      id: r.id,
      intent: r.intent,
      ...(r.title ? { title: r.title } : {}),
      ...(r.tag ? { tag: r.tag } : {}),
      ...(r.event_at ? { event_local: formatLocal(new Date(r.event_at), ctx.timezone) } : {}),
      status: r.status,
      cron: r.cron,
      next_local: r.due_at ? formatLocal(new Date(r.due_at), ctx.timezone) : null,
    }));
    return messages.length ? { reminders, scheduled_messages: messages } : reminders;
  },
});

export const cancelReminderTool = defineTool<{ id: string }>({
  name: "cancel_reminder",
  description: "Cancela um lembrete pelo id.",
  parameters: obj({ id: { type: "string" } }, ["id"]),
  async run(args, ctx) {
    return { ok: await cancelReminder(args.id, ctx.user.id) };
  },
});

export const rescheduleReminderTool = defineTool<{ id: string; at: string }>({
  name: "reschedule_reminder",
  description: "Muda o horário de um lembrete único (id de list_reminders). Recorrente: cancele e crie de novo com o cron novo.",
  parameters: obj(
    { id: { type: "string" }, at: { type: "string", description: "Nova data/hora local AAAA-MM-DDTHH:MM (do compromisso, se tiver; o aviso anda junto)" } },
    ["id", "at"],
  ),
  async run(args, ctx) {
    const at = parseLocalDateTime(args.at, ctx.timezone);
    const ok = await rescheduleReminder(args.id, at, ctx.user.id);
    return ok ? { ok, next_local: formatLocal(at, ctx.timezone) } : { ok, error: "Lembrete não encontrado ou já disparado" };
  },
});

export const setAlarm = defineTool<{ label: string; in_minutes?: number; at?: string }>({
  name: "set_alarm",
  description: "Alarme que toca no celular como ligação (e liga, se ela escolheu). in_minutes ou at.",
  parameters: obj(
    {
      label: { type: "string", description: "O que aparece na tela, curto (ex.: Tirar o bolo do forno)" },
      in_minutes: { type: "number" },
      at: { type: "string", description: "AAAA-MM-DDTHH:MM local" },
    },
    ["label"],
  ),
  async run(args, ctx) {
    const at = args.in_minutes != null ? new Date(Date.now() + args.in_minutes * 60_000) : args.at ? parseLocalDateTime(args.at, ctx.timezone) : null;
    if (!at) return { ok: false, error: "Informe in_minutes ou at" };
    const r = await createAlarm({ userId: ctx.user.id, conversationId: ctx.conversation.id, label: args.label, at });
    return {
      ok: true,
      id: r.id,
      ring_local: formatLocal(r.ringAt, ctx.timezone),
      // sem aparelho com notificação ligada, toca só no WhatsApp: vale avisar uma vez
      ...(r.devices ? {} : { note: "Nenhum celular com alarme ligado: chega no WhatsApp. Para tocar como ligação, ative em Minha conta > Alarmes no painel." }),
    };
  },
});

export const alarmList = defineTool<Record<string, never>>({
  name: "alarm_list",
  description: "Alarmes agendados (id para cancelar).",
  parameters: obj({}),
  async run(_a, ctx) {
    const rows = (await listAlarms(ctx.user.id)).filter((a) => a.status === "scheduled");
    return rows.length ? rows.map((a) => ({ id: a.id, label: a.label, ring_local: formatLocal(new Date(a.ring_at), ctx.timezone) })) : { alarms: [] };
  },
});

export const alarmCancel = defineTool<{ id: string }>({
  name: "alarm_cancel",
  description: "Cancela um alarme pelo id.",
  parameters: obj({ id: { type: "string" } }, ["id"]),
  async run(args, ctx) {
    if (!/^[0-9a-f-]{36}$/i.test(args.id)) return { ok: false, error: "id inválido: use alarm_list" };
    return { ok: await cancelAlarm(args.id, ctx.user.id) };
  },
});

const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export const calendarListEvents = defineTool<{ from: string; to: string; query?: string }>({
  name: "calendar_list_events",
  description: "Lista eventos do Google Agenda entre duas datas (horário local).",
  integration: "google",
  parameters: obj(
    { from: { type: "string", description: "AAAA-MM-DDTHH:MM" }, to: { type: "string" }, query: { type: "string" } },
    ["from", "to"],
  ),
  async run(args, ctx) {
    const params = new URLSearchParams({
      timeMin: parseLocalDateTime(args.from, ctx.timezone).toISOString(),
      timeMax: parseLocalDateTime(args.to, ctx.timezone).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "50",
      timeZone: ctx.timezone,
    });
    if (args.query) params.set("q", args.query);
    const j = await googleApi(`${CAL}?${params}`);
    return (j.items ?? []).map((e: any) => ({
      id: e.id,
      title: e.summary,
      start: e.start?.dateTime ?? e.start?.date,
      end: e.end?.dateTime ?? e.end?.date,
      location: e.location,
      link: e.htmlLink,
    }));
  },
});

export const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export const calendarCreateEvent = defineTool<{
  title: string;
  start: string;
  end?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  meet?: boolean;
  remind_minutes?: number;
  confirmed_by_user?: boolean;
}>({
  name: "calendar_create_event",
  description:
    "Evento no Google Agenda; meet=true cria o Meet; attendees recebem convite e lembretes do Google. " +
    "E-mail de convidado escrito no próprio pedido já vale como confirmação; senão o sistema pede o sim.",
  integration: "google",
  parameters: obj(
    {
      title: { type: "string" },
      start: { type: "string", description: "AAAA-MM-DDTHH:MM local" },
      end: { type: "string", description: "Padrão: 1h depois" },
      description: { type: "string" },
      location: { type: "string" },
      attendees: { type: "array", items: { type: "string" }, description: "E-mails" },
      meet: { type: "boolean" },
      remind_minutes: { type: "number", description: "Padrão 30" },
      ...CONFIRM_PARAM,
    },
    ["title", "start"],
  ),
  async run(args, ctx) {
    const attendees = [...new Set((args.attendees ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const bad = attendees.filter((e) => !EMAIL.test(e));
    if (bad.length) return { ok: false, error: `E-mail inválido: ${bad.join(", ")}. Peça o e-mail certo.` };
    // e-mail do convidado digitado pela própria pessoa nesta mensagem já é a confirmação (conferido no texto dela, não no
    // modelo); e-mail que só aparece num documento ou foto encaminhada não conta
    const said = (ctx.typedText ?? "").toLowerCase();
    if (attendees.some((e) => !said.includes(e))) {
      const c = await requireConfirmation(args, `convidar ${attendees.join(", ")} para "${args.title}"`, ctx);
      if (c) return c;
    }
    const start = parseLocalDateTime(args.start, ctx.timezone);
    const end = args.end ? parseLocalDateTime(args.end, ctx.timezone) : new Date(start.getTime() + 3_600_000);
    if (end <= start) return { ok: false, error: "O fim precisa ser depois do início." };
    const remind = Math.max(0, Math.min(40320, Math.round(args.remind_minutes ?? 30)));
    const params = new URLSearchParams({ sendUpdates: attendees.length ? "all" : "none" });
    if (args.meet) params.set("conferenceDataVersion", "1");
    const e = await googleApi(`${CAL}?${params}`, {
      method: "POST",
      body: JSON.stringify({
        summary: args.title,
        description: args.description,
        location: args.location,
        start: { dateTime: start.toISOString(), timeZone: ctx.timezone },
        end: { dateTime: end.toISOString(), timeZone: ctx.timezone },
        attendees: attendees.length ? attendees.map((email) => ({ email })) : undefined,
        reminders: { useDefault: false, overrides: [{ method: "popup", minutes: remind }, ...(remind < 60 ? [{ method: "email", minutes: 60 }] : [])] },
        conferenceData: args.meet
          ? { createRequest: { requestId: `pj-${ctx.user.id.slice(0, 8)}-${start.getTime()}`, conferenceSolutionKey: { type: "hangoutsMeet" } } }
          : undefined,
      }),
    });
    const meetLink = e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p: any) => p.entryPointType === "video")?.uri ?? null;
    return {
      ok: true,
      id: e.id,
      link: e.htmlLink,
      meet_link: meetLink,
      meet_pending: Boolean(args.meet && !meetLink && e.conferenceData?.createRequest?.status?.statusCode === "pending"),
      invited: attendees,
      reminder: `${remind} min antes`,
    };
  },
});
