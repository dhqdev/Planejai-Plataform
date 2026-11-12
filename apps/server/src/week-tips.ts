import { config } from "./config.js";
import { grainsLink } from "./credits.js";
import { many, one } from "./db/pool.js";
import { DOC, FONT, mascote } from "./doc-theme.js";
import { isOwner } from "./ingest.js";
import { QUEUES, getBoss } from "./queue/boss.js";
import { getSettings } from "./settings.js";
import { isoLocal } from "./time.js";
import { FOOTER } from "./trial-tips.js";
import { WEEK_TIPS, type WeekTip, type WeekTopic } from "./week-tips-texts.js";

/**
 * Dicas da semana depois do uso livre (pedido do David em 2026-11-12): por 7 dias depois que os dias livres acabam,
 * uma mensagem por dia mostrando o que dá para fazer com o Planejai, tirada das 100 de week-tips-texts.ts.
 * Texto pronto, sem IA (zero token e zero grão). Nos dias 1, 3, 5 e 7 a dica vai com uma imagem de exemplo da conversa.
 * - Cada pessoa recebe uma ordem própria (sorteio fixo pelo id), sem repetir dica nem assunto na semana, e começa
 *   pelo que ainda não usou (lembrete, gasto).
 * - Pula o dia se a pessoa já falou com o assistente nele, se nunca respondeu nada (protege o número), se é o dono,
 *   se já recebeu dica dos primeiros dias hoje ou se respondeu PARAR DICAS (o mesmo interruptor das dicas do teste).
 * - Quem está sem grãos (nunca pagou e o grátis acabou) recebe a dica com o link para voltar.
 */
export const WEEK_DAYS = 7;
/** Hora local de cada dia (1 a 7): varia para não virar "aquela mensagem das 10h"; o minuto é sorteado. */
export const WEEK_HOURS = [10, 12, 18, 11, 19, 10, 12] as const;
/** Dias que vão com imagem. */
export const IMAGE_DAYS = new Set([1, 3, 5, 7]);

export type WeekSent = { ids?: string[]; days?: number[]; last_on?: string };

export interface WeekCandidate {
  createdAt: Date;
  lastSeenAt: Date | null;
  timezone: string;
  /** dias livres do cadastro (mínimo 3, para nunca cruzar com as dicas dos primeiros dias) */
  trialDays: number;
  sent: WeekSent;
  /** dia (yyyy-mm-dd) da última dica dos primeiros dias */
  trialTipOn?: string;
  off: boolean;
}

const localDay = (d: Date, tz: string) => isoLocal(d, tz).slice(0, 10);
const localHour = (d: Date, tz: string) => Number(isoLocal(d, tz).slice(11, 13));
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Quantos dias a sequência espera depois do cadastro: os dias livres, nunca menos que 3. */
export const trialDaysFor = (days: unknown) => Math.max(3, Math.round(Number(days) || 0));

/** Que dia da semana de dicas (1 a 7) cabe agora, ou null. Pura: o teste cobre as regras. */
export function weekDayDue(c: WeekCandidate, now = new Date()): number | null {
  if (c.off || !c.lastSeenAt) return null;
  const tz = c.timezone;
  const today = localDay(now, tz);
  if (c.sent.last_on === today || c.trialTipOn === today) return null;
  // já conversou hoje: não precisa de empurrão
  if (localDay(c.lastSeenAt, tz) === today) return null;
  const endDay = localDay(new Date(c.createdAt.getTime() + c.trialDays * 86_400_000), tz);
  const day = dayDiff(endDay, today);
  if (day < 1 || day > WEEK_DAYS) return null;
  if ((c.sent.days ?? []).includes(day)) return null;
  if (localHour(now, tz) !== WEEK_HOURS[day - 1]) return null;
  return day;
}

/** Número fixo por pessoa (FNV-1a), para cada uma ter a sua ordem de dicas. */
function seedOf(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Embaralha com semente (mulberry32): a mesma pessoa sempre tem a mesma ordem. */
function shuffled<T>(xs: T[], seed: number) {
  const out = [...xs];
  let a = seed;
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * A dica do dia: na ordem da pessoa, a primeira que ela ainda não recebeu e de um assunto que não saiu nesta semana.
 * Dias com imagem pedem uma dica com exemplo de conversa. Nos dois primeiros dias, o que ela ainda não usou vem antes.
 */
export function pickWeekTip(o: { userId: string; day: number; sentIds: string[]; used: { reminders: number; expenses: number } }, tips = WEEK_TIPS): WeekTip {
  const sent = new Set(o.sentIds);
  const topicsDone = new Set(tips.filter((t) => sent.has(t.id)).map((t) => t.topic));
  const prefer: WeekTopic[] = [];
  if (o.day <= 2) {
    if (!o.used.reminders) prefer.push("lembretes");
    if (!o.used.expenses) prefer.push("gastos");
  }
  const order = shuffled(tips, seedOf(o.userId));
  const rank = (t: WeekTip) => {
    const p = prefer.indexOf(t.topic);
    return p < 0 ? prefer.length : p;
  };
  const fresh = order.filter((t) => !sent.has(t.id)).sort((a, b) => rank(a) - rank(b));
  const wantsImage = IMAGE_DAYS.has(o.day);
  return (
    fresh.find((t) => !topicsDone.has(t.topic) && (!wantsImage || t.chat)) ??
    fresh.find((t) => !topicsDone.has(t.topic)) ??
    fresh[0] ??
    order[0]!
  );
}

/** O texto que sai: a dica com o nome, o link de volta para quem está sem grãos e o rodapé de PARAR DICAS. */
export function weekTipText(t: WeekTip, o: { name?: string | null; blockedLink?: string | null }) {
  const first = (o.name ?? "").trim().split(/\s+/)[0] ?? "";
  const body = t.text.replace(/\{, nome\}/g, first ? `, ${first}` : "");
  const back = o.blockedLink ? `\n\n🔓 Pra eu voltar a te responder, é só escolher um plano 👉 ${o.blockedLink}` : "";
  return `${body}${back}\n\n${FOOTER}`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** Emoji sai da imagem: o navegador da stack pode não ter a fonte de emoji (viraria quadradinho). */
const noEmoji = (s: string) =>
  s
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "");
/** *negrito* e _itálico_ do WhatsApp no HTML da imagem; "•" vira bolinha. */
const waHtml = (s: string) =>
  esc(noEmoji(s))
    .replace(/\*([^*\n]+)\*/g, "<b>$1</b>")
    .replace(/(^|\s)_([^_\n]+)_(?=$|\s|[.,!?])/gm, "$1<i>$2</i>")
    .replace(/\n/g, "<br>");

/** HTML da imagem da dica: título e o exemplo de conversa (o que a pessoa manda e o que o Planejai responde). */
export function weekTipImageHtml(t: WeekTip) {
  const title = noEmoji(t.text.split("\n")[0]!.replace(/\*/g, "")).trim();
  const width = 720;
  const css = `*{box-sizing:border-box}html,body{margin:0;background:${DOC.marsh}}
body{font-family:${FONT};color:${DOC.ink};-webkit-font-smoothing:antialiased}
.page{width:${width}px;padding:48px 44px 40px;background:${DOC.marsh}}
.brand{display:flex;align-items:center;gap:12px;color:${DOC.violet};font-size:20px;font-weight:600}
h1{font-size:38px;line-height:1.15;margin:22px 0 30px;font-weight:700;letter-spacing:-.02em}
.chat{background:#fff;border:1px solid ${DOC.line};border-radius:28px;padding:26px 22px;display:flex;flex-direction:column;gap:14px}
.b{max-width:82%;padding:14px 18px;border-radius:20px;font-size:23px;line-height:1.4}
.eu{align-self:flex-end;background:${DOC.violet};color:#fff;border-bottom-right-radius:6px}
.pj{align-self:flex-start;background:${DOC.soft};color:${DOC.ink};border-bottom-left-radius:6px}
.who{font-size:15px;color:${DOC.muted};margin:0 6px -8px}.who.r{align-self:flex-end}
.foot{display:flex;align-items:center;justify-content:center;gap:8px;color:${DOC.muted};font-size:17px;margin-top:26px}
.foot b{color:${DOC.violet}}`;
  const chat = t.chat!;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="page">
<div class="brand">${mascote(38, "wk")}<span>dica do dia</span></div>
<h1>${esc(title)}</h1>
<div class="chat"><div class="who r">você</div><div class="b eu">${waHtml(chat.eu)}</div><div class="who">Planejai</div><div class="b pj">${waHtml(chat.planejai)}</div></div>
<div class="foot">é só mandar no WhatsApp do <b>planejai</b></div>
</div></body></html>`;
  return { html, width };
}

async function renderWeekTipImage(t: WeekTip) {
  const { htmlToPng } = await import("./charts.js");
  const { html, width } = weekTipImageHtml(t);
  return htmlToPng(html, width);
}

async function usage(userId: string) {
  const r = await one<{ reminders: number; expenses: number }>(
    `SELECT (SELECT COUNT(*)::int FROM reminders WHERE user_id = $1) AS reminders,
            (SELECT COUNT(*)::int FROM transactions WHERE user_id = $1 AND kind = 'expense') AS expenses`,
    [userId],
  );
  return { reminders: r?.reminders ?? 0, expenses: r?.expenses ?? 0 };
}

function candidate(u: any, s: Awaited<ReturnType<typeof getSettings>>): WeekCandidate {
  return {
    createdAt: new Date(u.created_at),
    lastSeenAt: u.last_seen_at ? new Date(u.last_seen_at) : null,
    timezone: u.timezone ?? s.timezone ?? config.DEFAULT_TIMEZONE,
    trialDays: trialDaysFor(s.billingTrialDays),
    sent: (u.profile?.week_tips ?? {}) as WeekSent,
    trialTipOn: u.profile?.trial_tips?.last_on,
    off: Boolean(u.profile?.trial_tips_off),
  };
}

const COLUMNS = "id, phone, name, full_name, status, timezone, profile, created_at, last_seen_at, billing_exempt";

/** De hora em hora (junto com as dicas dos primeiros dias): quem está na hora vai para a fila com atraso sorteado. */
export async function scheduleWeekTips(log?: { info: (...a: any[]) => void }, now = new Date()) {
  const s = await getSettings();
  const days = trialDaysFor(s.billingTrialDays);
  const rows = await many(
    `SELECT ${COLUMNS} FROM users WHERE status = 'active' AND last_seen_at IS NOT NULL
       AND created_at > now() - make_interval(days => $1) AND created_at < now() - make_interval(days => $2)
       AND NOT COALESCE((profile->>'trial_tips_off')::boolean, false)`,
    [days + WEEK_DAYS + 2, days],
  );
  const boss = await getBoss();
  let queued = 0;
  for (const u of rows) {
    if (isOwner(u.phone)) continue;
    const day = weekDayDue(candidate(u, s), now);
    if (!day) continue;
    const delay = 60 + Math.floor(Math.random() * 44 * 60);
    await boss.send(QUEUES.trialTips, { userId: u.id, week: day }, { startAfter: delay, singletonKey: `${u.id}:week${day}`, retryLimit: 1, retryDelay: 120 });
    queued++;
  }
  if (queued) log?.info({ queued }, "dicas da semana depois do teste na fila");
  return queued;
}

/** Na hora de mandar: confere de novo, escolhe a dica, marca uma vez só e manda (com imagem nos dias de imagem). */
export async function sendWeekTip(userId: string, day: number, now = new Date()) {
  const s = await getSettings();
  const u = await one(`SELECT ${COLUMNS} FROM users WHERE id = $1 AND status = 'active'`, [userId]);
  if (!u || isOwner(u.phone)) return false;
  const c = candidate(u, s);
  if (c.off || (c.sent.days ?? []).includes(day) || !c.lastSeenAt) return false;
  const tz = c.timezone;
  const today = localDay(now, tz);
  if (localDay(c.lastSeenAt, tz) === today || c.sent.last_on === today || c.trialTipOn === today) return false;
  const tip = pickWeekTip({ userId, day, sentIds: c.sent.ids ?? [], used: await usage(userId) });
  // sem grãos (cobrança ligada, grátis acabou): a dica leva o link para voltar
  const { billingAccess } = await import("./billing.js");
  const access = await billingAccess(u, s).catch(() => null);
  const text = weekTipText(tip, { name: u.full_name ?? u.name, blockedLink: access && !access.allowed ? grainsLink() : null });
  const claimed = await one(
    `UPDATE users SET profile = jsonb_set(profile, '{week_tips}',
        jsonb_build_object(
          'ids', COALESCE(profile->'week_tips'->'ids', '[]'::jsonb) || jsonb_build_array($3::text),
          'days', COALESCE(profile->'week_tips'->'days', '[]'::jsonb) || jsonb_build_array($2::int),
          'last_on', $4::text))
      WHERE id = $1 AND NOT COALESCE(profile->'week_tips'->'days', '[]'::jsonb) @> jsonb_build_array($2::int)
        AND COALESCE(profile->'week_tips'->>'last_on', '') <> $4 RETURNING id`,
    [userId, day, tip.id, today],
  );
  if (!claimed) return false;
  let image: { base64: string; mimetype: string } | undefined;
  if (IMAGE_DAYS.has(day) && tip.chat) {
    // sem navegador ou se falhar, a dica sai só em texto
    const png = await renderWeekTipImage(tip).catch(() => null);
    if (png) image = { base64: png, mimetype: "image/png" };
  }
  const { notifyUser } = await import("./social.js");
  await notifyUser(userId, text, image, { caption: true });
  return true;
}
