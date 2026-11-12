import { config } from "./config.js";
import { grains, grainsExempt, grainsLink, hasPaid, trialEndsAt } from "./credits.js";
import { many, one, query } from "./db/pool.js";
import { isOwner } from "./ingest.js";
import type { OnboardingAnswers } from "./onboarding.js";
import { QUEUES, getBoss } from "./queue/boss.js";
import { getSettings } from "./settings.js";
import { isoLocal } from "./time.js";

/**
 * Dicas dos primeiros dias (pedido do David em 2026-11-03): uma mensagem por dia, no máximo, para quem acabou de
 * entrar experimentar o assistente. Texto pronto, sem IA (zero token e zero grão).
 * - d1: dia seguinte ao cadastro, 9h: dica do que a pessoa escolheu no cadastro (onboarding).
 * - d2: dia 2, 12h: algo que ela ainda não usou (lembrete, gasto ou lista de compras).
 * - fim: manhã do último dia livre (ou a véspera, se o uso livre acaba antes das 11h): até quando vai, o que ela já fez e os grãos de presente.
 * Pula o dia se a pessoa já falou com o assistente nele, se nunca respondeu nada (protege o número), se já pagou,
 * se é o dono ou se respondeu PARAR DICAS. O horário tem minuto sorteado para não sair tudo junto.
 */
export type TipStep = "d1" | "d2" | "fim";
export type TipsSent = Partial<Record<TipStep, string>> & { last_on?: string };

/** Horas (locais) em que cada dica começa a sair; o minuto é sorteado dentro da hora. */
export const TIP_HOURS: Record<TipStep, number> = { d1: 9, d2: 12, fim: 9 };
/** O aviso de fim sai no próprio dia se o uso livre vai até pelo menos esta hora; antes disso, na véspera. */
const FIM_SAME_DAY_FROM = 11;
/** Só olha contas novas: depois disto a sequência acabou de qualquer jeito. */
const MAX_AGE_DAYS = 6;

const localDay = (d: Date, tz: string) => isoLocal(d, tz).slice(0, 10);
const localHour = (d: Date, tz: string) => Number(isoLocal(d, tz).slice(11, 13));
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export interface TipCandidate {
  createdAt: Date;
  lastSeenAt: Date | null;
  timezone: string;
  sent: TipsSent;
  off: boolean;
  /** fim do uso livre, só quando a cobrança vale para a pessoa (ligada, não isenta, nunca pagou) */
  trialEnd: Date | null;
}

/** Qual dica cabe agora (na hora de começar a mandar), ou null. Pura: o teste cobre as regras. */
export function tipDue(c: TipCandidate, now = new Date()): TipStep | null {
  if (c.off || !c.lastSeenAt) return null;
  const tz = c.timezone;
  const today = localDay(now, tz);
  if (c.sent.last_on === today) return null;
  // já conversou hoje: não precisa de empurrão
  if (localDay(c.lastSeenAt, tz) === today) return null;
  const hour = localHour(now, tz);
  if (c.trialEnd && !c.sent.fim && hour === TIP_HOURS.fim && c.trialEnd.getTime() > now.getTime()) {
    const endDay = localDay(c.trialEnd, tz);
    const endHour = localHour(c.trialEnd, tz);
    const gap = dayDiff(today, endDay);
    if ((gap === 0 && endHour >= FIM_SAME_DAY_FROM) || (gap === 1 && endHour < FIM_SAME_DAY_FROM)) return "fim";
  }
  const age = dayDiff(localDay(c.createdAt, tz), today);
  if (age === 1 && !c.sent.d1 && hour === TIP_HOURS.d1) return "d1";
  if (age === 2 && !c.sent.d2 && hour === TIP_HOURS.d2) return "d2";
  return null;
}

export const FOOTER = "_Se não quiser essas dicas, responde *PARAR DICAS*._";

const HABIT: Record<string, string> = {
  exercise: "me lembra de treinar às 18h todo dia",
  water: "me lembra de beber água a cada 2 horas",
  reading: "me lembra de ler 10 páginas às 21h",
  sleep: "me lembra às 22h30 de largar o celular",
  meditate: "me lembra de meditar às 7h todo dia",
};
const FORGET: Record<string, string> = {
  bills: "a conta de luz vence dia 10, me avisa um dia antes",
  meds: "remédio às 8h e às 20h todo dia",
  birthdays: "aniversário da minha mãe é 12 de março",
  meetings: "dentista quinta às 14h, me avisa 1 hora antes",
  tasks: "me lembra às 17h de mandar o relatório",
};
const MONEY_GOAL: Record<string, string> = {
  debt: "Com tudo anotado fica mais fácil achar onde cortar pra sair das dívidas.",
  reserve: "Com tudo anotado, você vê quanto dá pra guardar na reserva todo mês.",
  trip: "Com tudo anotado, você vê quanto sobra pra juntar pro que você quer.",
  invest: "Com tudo anotado, você descobre quanto sobra pra começar a investir.",
  control: "No fim do mês eu te mostro pra onde foi cada real.",
};

const list = (a: string | string[] | undefined) => (Array.isArray(a) ? a : a ? [a] : []);
const bullets = (xs: string[]) => xs.map((x) => `• "${x}"`);

/** O assunto que a dica do dia 1 mostrou (o dia 2 prefere outro). */
export function firstTopic(answers: OnboardingAnswers): "agenda" | "money" | "work" | "habits" | "study" {
  const g = list(answers.goal).find((x) => ["agenda", "money", "work", "habits", "study"].includes(x));
  return (g as ReturnType<typeof firstTopic>) ?? "agenda";
}

/** Dia 1: pelo que a pessoa quer primeiro no cadastro. */
export function tipDay1(name: string | null | undefined, answers: OnboardingAnswers = {}): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  const hi = `*Bom dia${first ? `, ${first}` : ""}!*`;
  const short = answers.tone === "short";
  const forget = list(answers.forget).map((f) => FORGET[f]).filter(Boolean) as string[];
  const topic = firstTopic(answers);
  let lines: string[];
  if (topic === "money") {
    const extra = MONEY_GOAL[String(answers.money_goal ?? "control")] ?? MONEY_GOAL.control!;
    lines = [`💰 ${hi}`, "", "Bora começar a organizar o dinheiro? Me conta o primeiro gasto do dia, tipo:", ...bullets(["gastei 12 no café", "paguei 89 de luz"]), ...(short ? [] : ["", extra])];
  } else if (topic === "habits") {
    const hs = list(answers.habit).map((h) => HABIT[h]).filter(Boolean) as string[];
    lines = [`🌱 ${hi}`, "", "Que tal começar o hábito hoje? Me pede o lembrete do seu jeito:", ...bullets((hs.length ? hs : [HABIT.water!]).slice(0, 2)), ...(short ? [] : ["", "Eu te chamo na hora certa, todo dia."])];
  } else if (topic === "work") {
    lines = [`💼 ${hi}`, "", "Tem reunião ou entrega hoje? Me manda que eu anoto e te aviso antes:", ...bullets(["reunião com o cliente às 14h, me avisa 30 min antes", ...forget.slice(0, 1)])];
  } else if (topic === "study") {
    lines = [`📚 ${hi}`, "", "Tem matéria pra revisar ou prova chegando? Pode me pedir:", ...bullets(["me explica juros compostos de um jeito simples", "me lembra de estudar às 19h"])];
  } else {
    lines = [`📅 ${hi}`, "", "Quer que eu te lembre de alguma coisa hoje? É só mandar do seu jeito, tipo:", ...bullets(["me lembra às 15h de ligar pro banco", ...(forget.length ? forget.slice(0, 1) : ["amanhã 8h academia"])])];
  }
  if (!short) lines.push("", "Pode mandar por áudio também 🎙️");
  return [...lines, "", FOOTER].join("\n");
}

export type Day2Kind = "lembrete" | "gasto" | "lista";

/** Dia 2: o que ela ainda não usou, de preferência um assunto diferente do dia 1. */
export function pickDay2(used: { reminders: number; expenses: number }, answers: OnboardingAnswers = {}): Day2Kind {
  const unused: Day2Kind[] = [];
  if (!used.reminders) unused.push("lembrete");
  if (!used.expenses) unused.push("gasto");
  if (!unused.length) return "lista";
  const shown: Day2Kind = firstTopic(answers) === "money" ? "gasto" : "lembrete";
  return unused.find((k) => k !== shown) ?? unused[0]!;
}

export function tipDay2(kind: Day2Kind): string {
  const body = {
    lembrete: [
      "⏰ *Uma dica rápida*",
      "",
      "Sabia que eu lembro de tudo por você? Manda do jeito que você falaria:",
      ...bullets(["me lembra de pagar o boleto sexta às 10h", "toda segunda 7h academia"]),
      "",
      "Pode ser por áudio também 🎙️",
    ],
    gasto: [
      "💸 *Uma dica rápida*",
      "",
      "Anotar gasto comigo leva dois segundos:",
      ...bullets(["gastei 35 no almoço", "uber 18"]),
      "",
      'Depois é só perguntar "quanto gastei esse mês" que eu respondo na hora.',
    ],
    lista: [
      "🛒 *Uma dica rápida*",
      "",
      "Também cuido da sua lista de compras:",
      ...bullets(["coloca na lista arroz, leite e café", "o que tem na minha lista?"]),
      "",
      "No mercado é só me pedir a lista que eu mando.",
    ],
  }[kind];
  return [...body, "", FOOTER].join("\n");
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Último dia: até quando vai o uso livre, o que a pessoa já fez e os grãos de presente. */
export function tipEnd(o: { end: Date; now?: Date; timezone: string; reminders: number; expenses: number; welcomeGrains: number; link: string }): string {
  const now = o.now ?? new Date();
  const gap = dayDiff(localDay(now, o.timezone), localDay(o.end, o.timezone));
  const [h, m] = isoLocal(o.end, o.timezone).slice(11, 16).split(":");
  const at = m === "00" ? `${Number(h)}h` : `${Number(h)}h${m}`;
  const done = [o.reminders ? `criou ${plural(o.reminders, "lembrete", "lembretes")}` : "", o.expenses ? `anotou ${plural(o.expenses, "gasto", "gastos")}` : ""].filter(Boolean);
  return [
    `⏳ *Seu uso livre vai até ${gap === 0 ? "hoje" : "amanhã"} às ${at}*`,
    "",
    ...(done.length ? ["Nesses dias você já:", ...done.map((d) => `• ${d}`)] : ["Ainda dá tempo de testar! Manda, por exemplo:", '• "me lembra amanhã às 9h do dentista"']),
    "",
    o.welcomeGrains > 0
      ? `Depois disso você continua comigo com *${grains(o.welcomeGrains)} de presente*. Quando quiser ver os planos: ${o.link}`
      : `Depois disso, pra continuar comigo é só escolher um plano: ${o.link}`,
    "",
    FOOTER,
  ].join("\n");
}

/** O que a pessoa já usou (contas simples, sem IA). */
async function usage(userId: string) {
  const r = await one<{ reminders: number; expenses: number }>(
    `SELECT (SELECT COUNT(*)::int FROM reminders WHERE user_id = $1) AS reminders,
            (SELECT COUNT(*)::int FROM transactions WHERE user_id = $1 AND kind = 'expense') AS expenses`,
    [userId],
  );
  return { reminders: r?.reminders ?? 0, expenses: r?.expenses ?? 0 };
}

async function candidate(u: any, s: Awaited<ReturnType<typeof getSettings>>): Promise<TipCandidate> {
  const trialEnd = !grainsExempt(u, s) ? trialEndsAt(u, s) : null;
  return {
    createdAt: new Date(u.created_at),
    lastSeenAt: u.last_seen_at ? new Date(u.last_seen_at) : null,
    timezone: u.timezone ?? s.timezone ?? config.DEFAULT_TIMEZONE,
    sent: (u.profile?.trial_tips ?? {}) as TipsSent,
    off: Boolean(u.profile?.trial_tips_off),
    trialEnd,
  };
}

const COLUMNS = "id, phone, name, full_name, status, timezone, profile, created_at, last_seen_at, billing_exempt";

/** De hora em hora: quem está na hora de uma dica vai para a fila com um atraso sorteado (1 a 45 min). */
export async function scheduleTrialTips(log?: { info: (...a: any[]) => void }, now = new Date()) {
  const s = await getSettings();
  const rows = await many(
    `SELECT ${COLUMNS} FROM users WHERE status = 'active' AND last_seen_at IS NOT NULL
       AND created_at > now() - make_interval(days => $1) AND NOT COALESCE((profile->>'trial_tips_off')::boolean, false)`,
    [MAX_AGE_DAYS],
  );
  const boss = await getBoss();
  let queued = 0;
  for (const u of rows) {
    if (isOwner(u.phone)) continue;
    const step = tipDue(await candidate(u, s), now);
    if (!step) continue;
    if (await hasPaid(u.id)) continue;
    const delay = 60 + Math.floor(Math.random() * 44 * 60);
    await boss.send(QUEUES.trialTips, { userId: u.id, step }, { startAfter: delay, singletonKey: `${u.id}:${step}`, retryLimit: 1, retryDelay: 120 });
    queued++;
  }
  if (queued) log?.info({ queued }, "dicas dos primeiros dias na fila");
  return queued;
}

/** Na hora de mandar: confere de novo (pode ter falado nesse meio tempo), marca uma vez só e manda. */
export async function sendTrialTip(userId: string, step: TipStep, now = new Date()) {
  const s = await getSettings();
  const u = await one(`SELECT ${COLUMNS} FROM users WHERE id = $1 AND status = 'active'`, [userId]);
  if (!u || isOwner(u.phone)) return false;
  const c = await candidate(u, s);
  if (c.off || c.sent[step]) return false;
  const tz = c.timezone;
  const today = localDay(now, tz);
  if (!c.lastSeenAt || localDay(c.lastSeenAt, tz) === today || c.sent.last_on === today) return false;
  if (step === "fim" && !(c.trialEnd && c.trialEnd.getTime() > now.getTime())) return false;
  if (await hasPaid(userId)) return false;
  const answers = ((u.profile?.onboarding?.answers ?? {}) as OnboardingAnswers) || {};
  const used = await usage(userId);
  const text =
    step === "d1"
      ? tipDay1(u.full_name ?? u.name, answers)
      : step === "d2"
        ? tipDay2(pickDay2(used, answers))
        : tipEnd({ end: c.trialEnd!, now, timezone: tz, ...used, welcomeGrains: Number(s.billingWelcomeGrains ?? 0), link: grainsLink() });
  const claimed = await one(
    `UPDATE users SET profile = jsonb_set(profile, '{trial_tips}', COALESCE(profile->'trial_tips', '{}'::jsonb) || jsonb_build_object($2::text, now(), 'last_on', $3::text))
      WHERE id = $1 AND NOT COALESCE(profile->'trial_tips' ? $2::text, false) AND COALESCE(profile->'trial_tips'->>'last_on', '') <> $3 RETURNING id`,
    [userId, step, today],
  );
  if (!claimed) return false;
  const { notifyUser } = await import("./social.js");
  await notifyUser(userId, text);
  return true;
}

/** "PARAR DICAS" no WhatsApp: desliga só as dicas dos primeiros dias. */
export async function stopTrialTips(userId: string) {
  await query("UPDATE users SET profile = profile || jsonb_build_object('trial_tips_off', true) WHERE id = $1", [userId]);
}
