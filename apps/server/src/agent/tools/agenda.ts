import { describeDirect, listDirect } from "../../direct.js";
import { googleApi } from "../../integrations/google.js";
import { resolveTag } from "../../agenda-tags.js";
import { cancelReminder, createReminder, listReminders, reminderOccurrences, retimeReminder } from "../../reminders.js";
import { formatLocal, parseLocalDateTime } from "../../time.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation, type ToolContext } from "./types.js";

/** Compromisso com hora em que a pessoa não disse quando quer o aviso: avisa este tanto antes. */
export const DEFAULT_LEAD_MIN = 30;

const hm = (d: Date, tz: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(d);
const dayOf = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);

export const scheduleReminder = defineTool<{
  intent: string;
  in_minutes?: number;
  at?: string;
  cron?: string;
  title?: string;
  event_at?: string;
  before_minutes?: number;
  tag?: string;
}>({
  name: "schedule_reminder",
  description:
    "Lembrete ou mensagem proativa: na hora o CTO escreve a mensagem a partir do intent. in_minutes, at (data/hora) ou cron (recorrente). " +
    "Compromisso com hora (consulta, reunião, \"preciso estar lá às 15h\"): title curto, tag do assunto e event_at; before_minutes se ela disse quando quer o aviso " +
    `(0 = na hora). Sem before_minutes o aviso sai ${DEFAULT_LEAD_MIN} min antes e o resultado traz ask_lead: pergunte numa linha se ela quer outra antecedência. ` +
    "O resultado mostra o que já tem no dia. " +
    "Com Google Agenda conectado, o lembrete único já vai para lá sozinho: não chame calendar_create_event junto.",
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
      before_minutes: { type: "number", description: "Avisar quantos minutos antes do event_at (no lugar de at)" },
      tag: { type: "string", description: "Assunto em 1 palavra (Saúde, Trabalho, Pet...); reaproveita as da pessoa" },
    },
    ["intent"],
  ),
  async run(args, ctx) {
    let dueAt: Date | null = null;
    if (args.in_minutes != null) dueAt = new Date(Date.now() + args.in_minutes * 60_000);
    else if (args.at) dueAt = parseLocalDateTime(args.at, ctx.timezone);
    const eventAt = args.event_at && !args.cron ? parseLocalDateTime(args.event_at, ctx.timezone) : null;
    if (eventAt && args.before_minutes != null && args.before_minutes > 0) dueAt = new Date(eventAt.getTime() - args.before_minutes * 60_000);
    // compromisso sem dizer quando avisar: já deixa um aviso antes (pedido do dono) e o CTO pergunta se ela quer outro
    const defaultLead = Boolean(eventAt && args.before_minutes == null && (!dueAt || Math.abs(dueAt.getTime() - eventAt.getTime()) < 60_000));
    if (eventAt && defaultLead) {
      const early = eventAt.getTime() - DEFAULT_LEAD_MIN * 60_000;
      dueAt = early > Date.now() + 60_000 ? new Date(early) : eventAt;
    }
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
    // compromisso com hora: vai junto o convite nativo do WhatsApp (o celular mostra o card e lembra do evento)
    const card = args.title && eventAt && !r.cron ? eventCard(ctx, { name: args.title, start: eventAt }) : null;
    return {
      ok: true,
      id: r.id,
      first_fire_local: formatLocal(r.dueAt, ctx.timezone),
      ...(eventAt ? { event_local: formatLocal(eventAt, ctx.timezone) } : {}),
      recurring: Boolean(r.cron),
      tag: tag ? `${tag.name}${tag.created ? " (nova)" : ""}` : null,
      ...(others.length ? { same_day: others.map((o) => `${hm(new Date(o.start), ctx.timezone)} ${o.title.slice(0, 40)}`) } : {}),
      ...(clash ? { clash: `Choca com ${clash.title.slice(0, 40)}` } : {}),
      ...(card ? { invite_card: card } : {}),
      ...(defaultLead && eventAt && dueAt && dueAt < eventAt
        ? { ask_lead: `Aviso ficou ${DEFAULT_LEAD_MIN} min antes (${hm(dueAt, ctx.timezone)}). Pergunte se ela quer ser lembrada mais cedo; se disser, use reschedule_reminder com before_minutes.` }
        : {}),
    };
  },
});

/**
 * Convite de evento do WhatsApp para a própria pessoa (Vou / Não vou e lembrete do celular). Só no WhatsApp embutido
 * e para compromisso que ainda vai acontecer. Sai sozinho depois do primeiro balão; devolve o media_id.
 */
export function eventCard(ctx: ToolContext, e: { name: string; start: Date; end?: Date; location?: string; description?: string }) {
  if (!ctx.channel?.rich || e.start.getTime() < Date.now() + 5 * 60_000) return null;
  return ctx.outbox.addMedia({
    kind: "event",
    event: { name: e.name, start: e.start.toISOString(), end: e.end?.toISOString(), location: e.location, description: e.description },
    fallbackText: `🗓️ ${e.name}, ${formatLocal(e.start, ctx.timezone)}`,
  });
}

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

export const rescheduleReminderTool = defineTool<{ id: string; at?: string; before_minutes?: number }>({
  name: "reschedule_reminder",
  description:
    "Muda um lembrete único (id de list_reminders): at move o compromisso (o aviso anda junto); before_minutes muda só a antecedência do aviso " +
    '("me lembra 1h antes" = 60, sem mexer no compromisso). Confirme com o que o resultado devolver. Recorrente: cancele e crie de novo.',
  parameters: obj(
    {
      id: { type: "string" },
      at: { type: "string", description: "Nova data/hora local AAAA-MM-DDTHH:MM do compromisso (ou do lembrete, se não tiver)" },
      before_minutes: { type: "number", description: "Avisar quantos minutos antes do compromisso (0 = na hora)" },
    },
    ["id"],
  ),
  async run(args, ctx) {
    if (!args.at && args.before_minutes == null) return { ok: false, error: "Diga o novo horário (at) ou a antecedência (before_minutes)" };
    const at = args.at ? parseLocalDateTime(args.at, ctx.timezone) : undefined;
    const r = await retimeReminder(args.id, ctx.user.id, { at, beforeMin: args.before_minutes });
    if (!r) return { ok: false, error: "Lembrete não encontrado ou já disparado" };
    // o que ficou gravado: a confirmação fala isso, não o pedido
    return r.beforeMin > 0
      ? { ok: true, event_local: formatLocal(r.eventAt, ctx.timezone), remind_local: formatLocal(r.dueAt, ctx.timezone), minutes_before: r.beforeMin }
      : { ok: true, remind_local: formatLocal(r.dueAt, ctx.timezone) };
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
    // e-mail inteiro, não pedaço: "ana@x.com" não vale porque a pessoa digitou "joana@x.com"
    const said = new Set((ctx.typedText ?? "").toLowerCase().match(/[^\s<>()[\]{},;:"']+@[^\s<>()[\]{},;:"']+\.[a-z]{2,}/g) ?? []);
    if (attendees.some((e) => !said.has(e))) {
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
    const card = eventCard(ctx, { name: args.title, start, end, location: args.location ?? meetLink ?? undefined, description: args.description });
    return {
      ok: true,
      id: e.id,
      link: e.htmlLink,
      meet_link: meetLink,
      meet_pending: Boolean(args.meet && !meetLink && e.conferenceData?.createRequest?.status?.statusCode === "pending"),
      invited: attendees,
      reminder: `${remind} min antes`,
      ...(card ? { invite_card: card } : {}),
    };
  },
});
