import { googleApi } from "../../integrations/google.js";
import { cancelReminder, createReminder, listReminders } from "../../reminders.js";
import { formatLocal, parseLocalDateTime } from "../../time.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

export const scheduleReminder = defineTool<{ intent: string; in_minutes?: number; at?: string; cron?: string }>({
  name: "schedule_reminder",
  description:
    "Agenda um lembrete/mensagem proativa. Na hora, o CTO escreve uma mensagem natural para a pessoa com base no 'intent' " +
    "(não existe template fixo). Use in_minutes para 'daqui X minutos', at para data/hora, cron para recorrência.",
  parameters: obj(
    {
      intent: {
        type: "string",
        description: "O que lembrar e o contexto, ex.: 'lembrar o David de ir ao banheiro (ele pediu há 15 min)'",
      },
      in_minutes: { type: "number", description: "Daqui a quantos minutos" },
      at: { type: "string", description: "Data/hora local AAAA-MM-DDTHH:MM no fuso da pessoa" },
      cron: { type: "string", description: "Recorrência em cron de 5 campos no fuso da pessoa, ex.: '0 8 * * 1-5'" },
    },
    ["intent"],
  ),
  async run(args, ctx) {
    let dueAt: Date | null = null;
    if (args.in_minutes != null) dueAt = new Date(Date.now() + args.in_minutes * 60_000);
    else if (args.at) dueAt = parseLocalDateTime(args.at, ctx.timezone);
    const r = await createReminder({
      userId: ctx.user.id,
      conversationId: ctx.conversation.id,
      intent: args.intent,
      dueAt,
      cron: args.cron ?? null,
      timezone: ctx.timezone,
    });
    return { ok: true, id: r.id, first_fire_local: formatLocal(r.dueAt, ctx.timezone), recurring: Boolean(r.cron) };
  },
});

export const listRemindersTool = defineTool<Record<string, never>>({
  name: "list_reminders",
  description: "Lista os lembretes da pessoa.",
  parameters: obj({}),
  async run(_a, ctx) {
    const rows = await listReminders(ctx.user.id);
    return rows.map((r) => ({
      id: r.id,
      intent: r.intent,
      status: r.status,
      cron: r.cron,
      next_local: r.due_at ? formatLocal(new Date(r.due_at), ctx.timezone) : null,
    }));
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

export const calendarCreateEvent = defineTool<{
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  attendees?: string[];
  confirmed_by_user?: boolean;
}>({
  name: "calendar_create_event",
  description: "Cria um evento no Google Agenda. Se tiver convidados, exige confirmação da pessoa.",
  integration: "google",
  parameters: obj(
    {
      title: { type: "string" },
      start: { type: "string", description: "AAAA-MM-DDTHH:MM local" },
      end: { type: "string", description: "AAAA-MM-DDTHH:MM local" },
      description: { type: "string" },
      location: { type: "string" },
      attendees: { type: "array", items: { type: "string" }, description: "e-mails" },
      ...CONFIRM_PARAM,
    },
    ["title", "start", "end"],
  ),
  async run(args, ctx) {
    if (args.attendees?.length) {
      const c = requireConfirmation(args, `convidar ${args.attendees.join(", ")} para "${args.title}"`);
      if (c) return c;
    }
    const e = await googleApi(`${CAL}?sendUpdates=all`, {
      method: "POST",
      body: JSON.stringify({
        summary: args.title,
        description: args.description,
        location: args.location,
        start: { dateTime: parseLocalDateTime(args.start, ctx.timezone).toISOString(), timeZone: ctx.timezone },
        end: { dateTime: parseLocalDateTime(args.end, ctx.timezone).toISOString(), timeZone: ctx.timezone },
        attendees: args.attendees?.map((email) => ({ email })),
      }),
    });
    return { ok: true, id: e.id, link: e.htmlLink };
  },
});
