import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { many, one, pool, query } from "./db/pool.js";
import { googleApi } from "./integrations/google.js";
import { QUEUES, getBoss } from "./queue/boss.js";
import { isoLocal, parseLocalDateTime } from "./time.js";
import { quietly, withGoogle } from "./calendar-sync.js";
import { cleanContactPhone } from "./phonebook.js";

/**
 * Link público de agendamento (estilo Calendly/Cal.com): cada pessoa tem /agendar/<slug> para pôr na bio do Instagram.
 * O cliente dela escolhe serviço, dia e um horário livre e deixa nome, WhatsApp e e-mail (o pré-cadastro, que vai para
 * os Contatos dela). O horário vira um compromisso na Agenda (lembrete com aviso, espelhado no Google Agenda se estiver
 * conectado) e os dois são lembrados perto da data por mensagens prontas, sem IA. Horário livre = dentro dos horários
 * da semana, fora de outro agendamento, de compromisso da Agenda e do que estiver ocupado no Google Agenda.
 */

export interface Service {
  id: string;
  name: string;
  minutes: number;
}
/** 0 = domingo; cada dia tem faixas ["09:00", "12:00"] */
export type Hours = Record<string, [string, string][]>;

export interface BookingPage {
  user_id: string;
  slug: string;
  enabled: boolean;
  title: string;
  about: string | null;
  services: Service[];
  hours: Hours;
  step_min: number;
  buffer_min: number;
  notice_min: number;
  days_ahead: number;
  owner_lead_min: number;
  client_leads: number[];
}

export interface Booking {
  id: string;
  user_id: string;
  service: string;
  minutes: number;
  start_at: Date;
  end_at: Date;
  client_name: string;
  client_phone: string;
  client_email: string | null;
  note: string | null;
  status: "confirmado" | "desmarcado";
  cancelled_by: string | null;
  token: string;
  reminder_id: string | null;
  created_at: Date;
}

export const DEFAULT_HOURS: Hours = Object.fromEntries([1, 2, 3, 4, 5].map((d) => [String(d), [["09:00", "12:00"], ["13:00", "18:00"]]]));
export const LEAD_CHOICES = [0, 15, 30, 60, 120, 180, 1440, 2880];
/** slugs que viram outra tela */
const RESERVED = new Set(["horario", "admin", "api", "novo", "config"]);
/** agendamentos futuros por WhatsApp em cada página: segura quem tenta lotar a agenda de alguém */
export const MAX_FUTURE_PER_PHONE = 3;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i;
const base = () => config.PUBLIC_URL.replace(/\/$/, "");
export const pageUrl = (slug: string) => `${base()}/agendar/${slug}`;
export const bookingUrl = (token: string) => `${base()}/agendar/horario/${token}`;

export function slugify(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

function cleanHours(raw: unknown): Hours {
  const out: Hours = {};
  if (!raw || typeof raw !== "object") return out;
  for (let d = 0; d < 7; d++) {
    const list = (raw as Record<string, unknown>)[String(d)];
    if (!Array.isArray(list)) continue;
    const ranges = list
      .filter((r): r is [string, string] => Array.isArray(r) && HHMM.test(String(r[0])) && HHMM.test(String(r[1])) && minutes(r[1]) > minutes(r[0]))
      .map((r) => [r[0], r[1]] as [string, string])
      .sort((a, b) => minutes(a[0]) - minutes(b[0]))
      .slice(0, 4);
    if (ranges.length) out[String(d)] = ranges;
  }
  return out;
}

function cleanServices(raw: unknown): Service[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Service[] = [];
  for (const s of raw.slice(0, 12)) {
    const name = String(s?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    const mins = Math.round(Number(s?.minutes));
    if (!name || !Number.isFinite(mins) || mins < 5 || mins > 480) continue;
    let id = String(s?.id ?? "").replace(/[^a-z0-9-]/gi, "").slice(0, 24) || slugify(name) || "servico";
    while (seen.has(id)) id = `${id}-${out.length + 1}`;
    seen.add(id);
    out.push({ id, name, minutes: mins });
  }
  return out;
}

const clamp = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

export async function getPage(userId: string) {
  return one<BookingPage>("SELECT * FROM booking_pages WHERE user_id = $1", [userId]);
}

export async function pageBySlug(slug: string) {
  return one<BookingPage>("SELECT * FROM booking_pages WHERE slug = $1 AND enabled", [slugify(slug)]);
}

async function freeSlug(wanted: string, userId: string) {
  const root = slugify(wanted) || "agenda";
  for (let n = 0; n < 50; n++) {
    const s = n ? `${root.slice(0, 36)}-${n + 1}` : root;
    if (RESERVED.has(s) || s.length < 3) continue;
    const taken = await one("SELECT 1 FROM booking_pages WHERE slug = $1 AND user_id <> $2", [s, userId]);
    if (!taken) return s;
  }
  return `${root.slice(0, 30)}-${randomBytes(3).toString("hex")}`;
}

/** Página da pessoa; na primeira vez cria uma desligada, com o nome dela e horário comercial, para ela só ajustar. */
export async function ensurePage(userId: string) {
  const has = await getPage(userId);
  if (has) return has;
  const u = await one<{ name: string | null; full_name: string | null }>("SELECT name, full_name FROM users WHERE id = $1", [userId]);
  const title = (u?.full_name || u?.name || "Minha agenda").trim().slice(0, 60);
  const slug = await freeSlug(title, userId);
  await query(
    `INSERT INTO booking_pages (user_id, slug, enabled, title, services, hours) VALUES ($1, $2, false, $3, $4, $5) ON CONFLICT (user_id) DO NOTHING`,
    [userId, slug, title, JSON.stringify([{ id: "atendimento", name: "Atendimento", minutes: 60 }]), JSON.stringify(DEFAULT_HOURS)],
  );
  return (await getPage(userId))!;
}

export async function savePage(userId: string, b: Record<string, any>) {
  const cur = await ensurePage(userId);
  let slug = cur.slug;
  if (b.slug !== undefined && slugify(String(b.slug)) !== cur.slug) {
    const s = slugify(String(b.slug));
    if (s.length < 3) throw new Error("O endereço precisa de pelo menos 3 letras ou números");
    if (RESERVED.has(s)) throw new Error("Esse endereço é reservado, escolha outro");
    if (await one("SELECT 1 FROM booking_pages WHERE slug = $1 AND user_id <> $2", [s, userId])) throw new Error("Esse endereço já é de outra pessoa");
    slug = s;
  }
  const title = b.title !== undefined ? String(b.title).replace(/\s+/g, " ").trim().slice(0, 60) : cur.title;
  if (!title) throw new Error("Dê um nome para a página");
  const services = b.services !== undefined ? cleanServices(b.services) : cur.services;
  if (!services.length) throw new Error("Cadastre pelo menos um serviço com nome e duração");
  const hours = b.hours !== undefined ? cleanHours(b.hours) : cur.hours;
  const enabled = b.enabled !== undefined ? Boolean(b.enabled) : cur.enabled;
  if (enabled && !Object.keys(hours).length) throw new Error("Marque pelo menos um dia com horário de atendimento");
  const leads =
    b.client_leads !== undefined
      ? [...new Set((Array.isArray(b.client_leads) ? b.client_leads : []).map((n: unknown) => clamp(n, 0, 10080, 0)).filter((n: number) => n > 0))].slice(0, 3)
      : cur.client_leads;
  await query(
    `UPDATE booking_pages SET slug = $2, enabled = $3, title = $4, about = $5, services = $6, hours = $7, step_min = $8, buffer_min = $9,
            notice_min = $10, days_ahead = $11, owner_lead_min = $12, client_leads = $13, updated_at = now()
      WHERE user_id = $1`,
    [
      userId,
      slug,
      enabled,
      title,
      b.about !== undefined ? String(b.about ?? "").replace(/\s+/g, " ").trim().slice(0, 160) || null : cur.about,
      JSON.stringify(services),
      JSON.stringify(hours),
      b.step_min !== undefined ? clamp(b.step_min, 5, 240, 30) : cur.step_min,
      b.buffer_min !== undefined ? clamp(b.buffer_min, 0, 120, 0) : cur.buffer_min,
      b.notice_min !== undefined ? clamp(b.notice_min, 0, 7 * 1440, 120) : cur.notice_min,
      b.days_ahead !== undefined ? clamp(b.days_ahead, 1, 90, 30) : cur.days_ahead,
      b.owner_lead_min !== undefined ? clamp(b.owner_lead_min, 0, 2880, 60) : cur.owner_lead_min,
      leads,
    ],
  );
  return (await getPage(userId))!;
}

// ---------- Horários livres ----------

type Busy = { s: number; e: number };
const googleBusy = new Map<string, { at: number; from: number; to: number; busy: Busy[] }>();

/** Ocupado no Google Agenda da pessoa (freeBusy do calendário principal); guarda 60 s para a página não martelar a API. */
async function busyOnGoogle(userId: string, from: Date, to: Date): Promise<Busy[]> {
  const c = googleBusy.get(userId);
  if (c && Date.now() - c.at < 60_000 && c.from <= from.getTime() && c.to >= to.getTime()) return c.busy;
  const r = await withGoogle(userId, () =>
    googleApi("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: "primary" }] }),
      signal: AbortSignal.timeout(8_000),
    }),
  ).catch((err) => {
    console.error("[agendamento] freeBusy", (err as Error).message);
    return null;
  });
  const busy: Busy[] = (r?.calendars?.primary?.busy ?? [])
    .map((b: { start: string; end: string }) => ({ s: new Date(b.start).getTime(), e: new Date(b.end).getTime() }))
    .filter((b: Busy) => Number.isFinite(b.s) && Number.isFinite(b.e));
  if (googleBusy.size > 500) googleBusy.clear();
  googleBusy.set(userId, { at: Date.now(), from: from.getTime(), to: to.getTime(), busy });
  return busy;
}

/** Esquece o ocupado do Google guardado (agendou agora, ou nos testes). */
export const forgetGoogleBusy = (userId: string) => googleBusy.delete(userId);

/** Agendamentos confirmados e compromissos da Agenda (lembretes com horário de compromisso) entre duas datas. */
async function busyInDb(userId: string, from: Date, to: Date, db: { query: typeof query } = { query }): Promise<Busy[]> {
  const r = await db.query(
    `SELECT start_at AS s, end_at AS e FROM bookings WHERE user_id = $1 AND status = 'confirmado' AND start_at < $3 AND end_at > $2
     UNION ALL
     SELECT event_at, event_at + make_interval(mins => COALESCE(event_minutes, 60)) FROM reminders
      WHERE user_id = $1 AND status = 'scheduled' AND cron IS NULL AND event_at IS NOT NULL
        AND event_at < $3 AND event_at + make_interval(mins => COALESCE(event_minutes, 60)) > $2
        AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.reminder_id = reminders.id)`,
    [userId, from, to],
  );
  return r.rows.map((x: { s: Date; e: Date }) => ({ s: new Date(x.s).getTime(), e: new Date(x.e).getTime() }));
}

const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();

/**
 * Horários livres por dia (AAAA-MM-DD no fuso da pessoa), puro para testar: faixas da semana, passo, duração do
 * serviço, folga entre atendimentos, antecedência mínima e o que já está ocupado.
 */
export function freeSlots(page: Pick<BookingPage, "hours" | "step_min" | "buffer_min" | "notice_min" | "days_ahead">, minutesLong: number, busy: Busy[], tz: string, now = new Date()) {
  const out: Record<string, string[]> = {};
  const earliest = now.getTime() + page.notice_min * 60_000;
  const dur = minutesLong * 60_000;
  const gap = page.buffer_min * 60_000;
  const step = Math.max(5, page.step_min) * 60_000;
  const days = new Set<string>();
  for (let i = 0; i <= page.days_ahead; i++) days.add(isoLocal(new Date(now.getTime() + i * 86400_000), tz).slice(0, 10));
  for (const day of days) {
    const list: string[] = [];
    for (const [a, b] of page.hours[String(weekday(day))] ?? []) {
      const end = parseLocalDateTime(`${day}T${b}`, tz).getTime();
      for (let t = parseLocalDateTime(`${day}T${a}`, tz).getTime(); t + dur <= end; t += step) {
        if (t < earliest) continue;
        if (busy.some((x) => x.s - gap < t + dur && t < x.e + gap)) continue;
        list.push(new Date(t).toISOString());
      }
    }
    if (list.length) out[day] = list;
  }
  return out;
}

export async function tzOf(userId: string) {
  const u = await one<{ timezone: string | null }>("SELECT timezone FROM users WHERE id = $1", [userId]);
  return u?.timezone || config.DEFAULT_TIMEZONE;
}

export async function availability(page: BookingPage, serviceId: string) {
  const service = page.services.find((s) => s.id === serviceId) ?? page.services[0];
  if (!service) return { service: null, tz: config.DEFAULT_TIMEZONE, days: {} as Record<string, string[]> };
  const tz = await tzOf(page.user_id);
  const from = new Date();
  const to = new Date(from.getTime() + (page.days_ahead + 1) * 86400_000);
  const busy = [...(await busyInDb(page.user_id, from, to)), ...(await busyOnGoogle(page.user_id, from, to))];
  return { service, tz, days: freeSlots(page, service.minutes, busy, tz) };
}

/** O que a página pública mostra (nada de dado interno). */
export function publicPage(p: BookingPage) {
  return { slug: p.slug, title: p.title, about: p.about, services: p.services, days_ahead: p.days_ahead };
}

// ---------- Textos (prontos, sem IA) ----------

const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
export function whenText(d: Date, tz: string, now = new Date()) {
  const day = isoLocal(d, tz).slice(0, 10);
  const hour = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(d);
  if (day === isoLocal(now, tz).slice(0, 10)) return `hoje, às ${hour}`;
  if (day === isoLocal(new Date(now.getTime() + 86400_000), tz).slice(0, 10)) return `amanhã, às ${hour}`;
  const date = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(d);
  return `${date}, às ${hour}`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const phoneText = (p: string) => `+${p}`;

// ---------- Envio para o cliente (WhatsApp pelo número do Planejai; e-mail pelo Gmail da pessoa, se conectado) ----------

async function sendWhatsApp(phone: string, text: string) {
  await (await getBoss()).send(QUEUES.outbound, { type: "send", userId: null, phone, channel: "whatsapp", text }, { retryLimit: 2, retryDelay: 30 });
}

async function sendEmail(ownerId: string, to: string | null, subject: string, body: string) {
  if (!to || !EMAIL.test(to)) return;
  await quietly(
    withGoogle(ownerId, async () => {
      const raw = [
        `To: ${to}`,
        `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        body,
      ].join("\r\n");
      await googleApi("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url") }),
        signal: AbortSignal.timeout(10_000),
      });
    }),
  );
}

async function notifyOwner(userId: string, text: string) {
  const { notifyUser } = await import("./social.js");
  await notifyUser(userId, text).catch((err) => console.error("[agendamento] aviso à pessoa", (err as Error).message));
}

const plain = (s: string) => s.replace(/\*/g, "");

async function tellClient(b: Booking, page: BookingPage, text: string, subject: string) {
  await sendWhatsApp(b.client_phone, text);
  await sendEmail(b.user_id, b.client_email, subject, `${plain(text)}\n\n${page.title}`);
}

/** Avisos do cliente perto da data: cada um confere na hora se o horário ainda vale (desmarcado ou remarcado, não sai). */
async function scheduleClientReminders(b: Booking, page: BookingPage) {
  const boss = await getBoss();
  for (const lead of page.client_leads) {
    const at = new Date(b.start_at).getTime() - lead * 60_000;
    // aviso que cairia quase junto da confirmação não vale a pena
    if (at < Date.now() + 15 * 60_000) continue;
    await boss.send(QUEUES.booking, { bookingId: b.id, start: new Date(b.start_at).toISOString() }, { startAfter: new Date(at), retryLimit: 2, retryDelay: 60 });
  }
}

// ---------- Agendar, desmarcar, remarcar ----------

export class BookingError extends Error {}

export interface BookInput {
  service?: string;
  start?: string;
  name?: string;
  phone?: string;
  email?: string;
  note?: string;
}

export async function book(page: BookingPage, input: BookInput) {
  const service = page.services.find((s) => s.id === input.service);
  if (!service) throw new BookingError("Escolha um dos serviços");
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (name.length < 2) throw new BookingError("Diga seu nome");
  const phone = cleanContactPhone(String(input.phone ?? ""));
  if (!phone) throw new BookingError("Confira seu WhatsApp com DDD");
  const email = String(input.email ?? "").trim().slice(0, 120) || null;
  if (email && !EMAIL.test(email)) throw new BookingError("Confira seu e-mail");
  const note = String(input.note ?? "").trim().slice(0, 300) || null;
  const start = new Date(String(input.start ?? ""));
  if (Number.isNaN(start.getTime())) throw new BookingError("Escolha um horário");

  const tz = await tzOf(page.user_id);
  const from = new Date();
  const to = new Date(from.getTime() + (page.days_ahead + 1) * 86400_000);
  const google = await busyOnGoogle(page.user_id, from, to);
  const end = new Date(start.getTime() + service.minutes * 60_000);

  const client = await pool.connect();
  let b: Booking;
  try {
    await client.query("BEGIN");
    // um agendamento por vez em cada agenda: dois clientes no mesmo horário, só o primeiro leva
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agendar:${page.user_id}`]);
    const future = await client.query(
      "SELECT COUNT(*)::int AS n FROM bookings WHERE user_id = $1 AND client_phone = $2 AND status = 'confirmado' AND start_at > now()",
      [page.user_id, phone],
    );
    if (future.rows[0].n >= MAX_FUTURE_PER_PHONE) throw new BookingError(`Você já tem ${MAX_FUTURE_PER_PHONE} horários marcados aqui. Desmarque um para pegar outro.`);
    const busy = [...(await busyInDb(page.user_id, from, to, client as unknown as { query: typeof query })), ...google];
    const day = isoLocal(start, tz).slice(0, 10);
    if (!(freeSlots(page, service.minutes, busy, tz)[day] ?? []).includes(start.toISOString()))
      throw new BookingError("Esse horário acabou de ser ocupado. Escolha outro, por favor.");
    const r = await client.query(
      `INSERT INTO bookings (user_id, service, minutes, start_at, end_at, client_name, client_phone, client_email, note, token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [page.user_id, service.name, service.minutes, start, end, name, phone, email, note, randomBytes(18).toString("base64url")],
    );
    b = r.rows[0];
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await afterBooked(b, page, tz);
  return b;
}

async function afterBooked(b: Booking, page: BookingPage, tz: string) {
  const owner = await one<{ id: string; phone: string }>("SELECT id, phone FROM users WHERE id = $1", [b.user_id]);
  if (!owner) return;
  // compromisso na Agenda da pessoa (vai junto para o Google Agenda, se conectado), com o aviso dela antes
  try {
    const { conversationOf } = await import("./social.js");
    const { createReminder } = await import("./reminders.js");
    const { resolveTag } = await import("./agenda-tags.js");
    const { conv } = await conversationOf(owner.id, owner.phone);
    const tag = await resolveTag(owner.id, "Agendamento", "", { color: "#5b45e8", exact: true });
    const r = await createReminder({
      userId: owner.id,
      conversationId: conv.id,
      intent:
        `Agendamento pelo link: ${b.service} com ${b.client_name} (WhatsApp ${phoneText(b.client_phone)}` +
        `${b.client_email ? `, e-mail ${b.client_email}` : ""})${b.note ? `. Recado do cliente: ${b.note}` : ""}`,
      title: `${b.client_name} · ${b.service}`.slice(0, 80),
      eventAt: new Date(b.start_at),
      eventMinutes: b.minutes,
      dueAt: new Date(Math.max(new Date(b.start_at).getTime() - page.owner_lead_min * 60_000, Date.now() + 5_000)),
      timezone: tz,
      tag: tag?.name ?? null,
      color: tag?.color ?? "#5b45e8",
      skipLimit: true,
    });
    await query("UPDATE bookings SET reminder_id = $2 WHERE id = $1", [b.id, r.id]);
  } catch (err) {
    console.error("[agendamento] agenda", (err as Error).message);
  }
  // o cliente entra nos Contatos da pessoa (pré-cadastro)
  try {
    const { saveContact } = await import("./phonebook.js");
    await saveContact(owner.id, b.client_name, b.client_phone, "agendamento");
  } catch {
    /* contato já salvo ou agenda cheia: o agendamento vale do mesmo jeito */
  }
  const when = whenText(new Date(b.start_at), tz);
  await notifyOwner(
    owner.id,
    `*Novo agendamento pelo seu link* 📅\n\n• ${b.service} com ${b.client_name}\n• ${cap(when)}\n• WhatsApp: ${phoneText(b.client_phone)}` +
      (b.client_email ? `\n• E-mail: ${b.client_email}` : "") +
      (b.note ? `\n• Recado: ${b.note}` : "") +
      "\n\nJá está na sua Agenda e eu lembro vocês dois perto do horário.",
  );
  await tellClient(
    b,
    page,
    `*Horário confirmado* ✅\n\nOi, ${first(b.client_name)}! Seu horário com *${page.title}* está marcado:\n• ${b.service}\n• ${cap(when)}\n\n` +
      `Eu te lembro perto da data. Se precisar desmarcar, é por aqui: ${bookingUrl(b.token)}\n\n_Mensagem automática do Planejai._`,
    `Horário confirmado com ${page.title}`,
  );
  await scheduleClientReminders(b, page);
}

/** Fila booking.remind: aviso do cliente perto da data, se o horário ainda for o mesmo. */
export async function runClientReminder(data: { bookingId: string; start: string }) {
  const b = await one<Booking>("SELECT * FROM bookings WHERE id = $1", [data.bookingId]);
  if (!b || b.status !== "confirmado" || new Date(b.start_at).toISOString() !== data.start) return false;
  if (new Date(b.start_at).getTime() < Date.now()) return false;
  const page = await getPage(b.user_id);
  if (!page) return false;
  const tz = await tzOf(b.user_id);
  await tellClient(
    b,
    page,
    `*Lembrete do seu horário* ⏰\n\nOi, ${first(b.client_name)}! ${cap(whenText(new Date(b.start_at), tz))} você tem *${b.service}* com *${page.title}*.\n\n` +
      `Se não puder ir, desmarque aqui para liberar o horário: ${bookingUrl(b.token)}`,
    `Lembrete: ${b.service} com ${page.title}`,
  );
  return true;
}

/** Na hora do aviso da pessoa: texto pronto do agendamento ligado a este lembrete (null = lembrete comum, segue com o CTO). */
export async function ownerReminderText(reminderId: string) {
  const b = await one<Booking>("SELECT * FROM bookings WHERE reminder_id = $1 AND status = 'confirmado'", [reminderId]);
  if (!b) return null;
  const tz = await tzOf(b.user_id);
  return (
    `*Agendamento ${whenText(new Date(b.start_at), tz)}* ⏰\n\n• ${b.service} com ${b.client_name}\n• WhatsApp: ${phoneText(b.client_phone)}` +
    (b.note ? `\n• Recado: ${b.note}` : "")
  );
}

export async function bookingByToken(token: string) {
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(token)) return null;
  return one<Booking>("SELECT * FROM bookings WHERE token = $1", [token]);
}

/** O cliente desmarcou pelo link: some da Agenda (e do Google) e a pessoa fica sabendo. */
export async function cancelByClient(token: string) {
  const b = await one<Booking>(
    "UPDATE bookings SET status = 'desmarcado', cancelled_by = 'cliente', cancelled_at = now() WHERE token = $1 AND status = 'confirmado' AND start_at > now() RETURNING *",
    [token],
  );
  if (!b) return null;
  if (b.reminder_id) {
    const { cancelReminder } = await import("./reminders.js");
    await cancelReminder(b.reminder_id).catch(() => {});
  }
  const tz = await tzOf(b.user_id);
  await notifyOwner(b.user_id, `*${b.client_name} desmarcou* 🗓️\n\n• ${b.service}, ${whenText(new Date(b.start_at), tz)}\n\nO horário ficou livre de novo no seu link.`);
  return b;
}

/** A pessoa desmarcou (pela Agenda, pelo WhatsApp ou pela tela do link): o cliente fica sabendo e pode escolher outro horário. */
async function ownerCancelled(id: string) {
  const b = await one<Booking>(
    "UPDATE bookings SET status = 'desmarcado', cancelled_by = 'dono', cancelled_at = now() WHERE id = $1 AND status = 'confirmado' RETURNING *",
    [id],
  );
  if (!b || new Date(b.start_at).getTime() < Date.now()) return;
  const page = await getPage(b.user_id);
  if (!page) return;
  const tz = await tzOf(b.user_id);
  await tellClient(
    b,
    page,
    `Oi, ${first(b.client_name)}. *${page.title}* precisou desmarcar seu horário de ${whenText(new Date(b.start_at), tz)} (${b.service}).` +
      (page.enabled ? `\n\nPara escolher outro horário: ${pageUrl(page.slug)}` : "") +
      "\n\n_Mensagem automática do Planejai._",
    `Horário desmarcado: ${b.service}`,
  );
}

/** O compromisso ligado a um agendamento foi excluído da Agenda. */
export async function onReminderCancelled(reminderId: string) {
  const b = await one<{ id: string }>("SELECT id FROM bookings WHERE reminder_id = $1 AND status = 'confirmado'", [reminderId]);
  if (b) await ownerCancelled(b.id);
}

/** A pessoa mudou o horário na Agenda (arrastou ou editou): o agendamento anda junto e o cliente é avisado. */
export async function onReminderMoved(reminderId: string, at: Date) {
  const b = await one<Booking>("SELECT * FROM bookings WHERE reminder_id = $1 AND status = 'confirmado'", [reminderId]);
  if (!b || new Date(b.start_at).getTime() === at.getTime()) return;
  const moved = await one<Booking>("UPDATE bookings SET start_at = $2, end_at = $3 WHERE id = $1 RETURNING *", [b.id, at, new Date(at.getTime() + b.minutes * 60_000)]);
  const page = await getPage(b.user_id);
  if (!moved || !page) return;
  const tz = await tzOf(b.user_id);
  await tellClient(
    moved,
    page,
    `*Seu horário mudou* 🗓️\n\nOi, ${first(b.client_name)}! *${page.title}* passou seu horário (${b.service}) para *${whenText(at, tz)}*.\n\n` +
      `Se não puder nesse horário, desmarque aqui: ${bookingUrl(b.token)}\n\n_Mensagem automática do Planejai._`,
    `Horário remarcado: ${b.service}`,
  );
  await scheduleClientReminders(moved, page);
}

/** Próximos agendamentos e os desmarcados há pouco, para a tela da pessoa. */
export async function listBookings(userId: string) {
  return many(
    `SELECT id, service, minutes, start_at, end_at, client_name, client_phone, client_email, note, status, cancelled_by, created_at
       FROM bookings WHERE user_id = $1 AND end_at > now() - interval '1 day' AND (status = 'confirmado' OR cancelled_at > now() - interval '7 days')
      ORDER BY start_at LIMIT 200`,
    [userId],
  );
}

/** A pessoa desmarca pela tela do link: mesmo caminho de excluir na Agenda. */
export async function cancelByOwner(userId: string, id: string) {
  const b = await one<Booking>("SELECT * FROM bookings WHERE id = $1 AND user_id = $2 AND status = 'confirmado'", [id, userId]);
  if (!b) return false;
  if (b.reminder_id) {
    const { cancelReminder } = await import("./reminders.js");
    // tira da Agenda e do Google; o cancelReminder chama onReminderCancelled, que avisa o cliente
    if (await cancelReminder(b.reminder_id, userId)) return true;
  }
  // aviso da pessoa já disparou (o compromisso saiu dos lembretes): desmarca direto
  await ownerCancelled(b.id);
  return true;
}
