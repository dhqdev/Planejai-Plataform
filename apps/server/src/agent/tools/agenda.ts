import { googleApi } from "../../integrations/google.js";
import { cancelReminder, createReminder, listReminders, rescheduleReminder } from "../../reminders.js";
import { formatLocal, parseLocalDateTime } from "../../time.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

export const scheduleReminder = defineTool<{ intent: string; in_minutes?: number; at?: string; cron?: string }>({
  name: "schedule_reminder",
  description:
    "Lembrete ou mensagem proativa: na hora o CTO escreve a mensagem a partir do intent. in_minutes, at (data/hora) ou cron (recorrente).",
  parameters: obj(
    {
      intent: {
        type: "string",
        description: "O que lembrar, com contexto (quem pediu e por quê)",
      },
      in_minutes: { type: "number" },
      at: { type: "string", description: "AAAA-MM-DDTHH:MM local" },
      cron: { type: "string", description: "5 campos, fuso da pessoa, ex.: 0 8 * * 1-5" },
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
  description: "Lista os lembretes agendados da pessoa (com id, para mudar o horário ou cancelar).",
  parameters: obj({}),
  async run(_a, ctx) {
    const rows = (await listReminders(ctx.user.id)).filter((r) => r.status === "scheduled");
    if (!rows.length) return { reminders: [], note: "Nenhum lembrete agendado." };
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

export const rescheduleReminderTool = defineTool<{ id: string; at: string }>({
  name: "reschedule_reminder",
  description: "Muda o horário de um lembrete único (id de list_reminders). Recorrente: cancele e crie de novo com o cron novo.",
  parameters: obj({ id: { type: "string" }, at: { type: "string", description: "Nova data/hora local AAAA-MM-DDTHH:MM" } }, ["id", "at"]),
  async run(args, ctx) {
    const at = parseLocalDateTime(args.at, ctx.timezone);
    const ok = await rescheduleReminder(args.id, at, ctx.user.id);
    return ok ? { ok, next_local: formatLocal(at, ctx.timezone) } : { ok, error: "Lembrete não encontrado ou já disparado" };
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

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

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
    // e-mail do convidado escrito pela própria pessoa nesta mensagem já é a confirmação (conferido no texto dela, não no modelo)
    const said = (ctx.inboundText ?? "").toLowerCase();
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
