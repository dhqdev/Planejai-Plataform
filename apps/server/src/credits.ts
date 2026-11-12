import { config } from "./config.js";
import { many, one, pool, query } from "./db/pool.js";
import { isOwner } from "./ingest.js";
import { notify } from "./notifications.js";
import { QUEUES, getBoss } from "./queue/boss.js";
import { type AgentSettings, type BillingPlan, getSettings } from "./settings.js";

/**
 * Grãos: o crédito do Planejai. O assistente gasta grãos conforme o custo real de IA de cada resposta
 * (custo do OpenRouter × billingGrainsPerUsd, com fração: o pedaço de grão que sobra fica em wallets.grain_remainder
 * e entra no próximo passo, então nada é arredondado a mais nem sai de graça). A carteira tem dois bolsos:
 * - plano: recarrega para a quantidade do plano a cada mês pago (o que sobrou não acumula);
 * - extras: boas-vindas e pacotes avulsos; não vencem.
 * O uso tira primeiro do plano. Com a carteira zerada (e a cobrança ligada) o assistente para e manda o link
 * para comprar mais ou trocar de plano. Dono e pessoas liberadas nunca gastam grãos.
 */

export interface Wallet {
  plan: number;
  extra: number;
  total: number;
}

export const GRAIN_REASON: Record<string, string> = {
  "boas-vindas": "Boas-vindas",
  plano: "Recarga do plano",
  pacote: "Pacote avulso",
  troca: "Troca de plano",
  uso: "Uso do assistente",
  ajuste: "Ajuste",
};

const nf = new Intl.NumberFormat("pt-BR");
export const grains = (n: number) => `${nf.format(Math.max(0, Math.round(n)))} ${Math.round(n) === 1 ? "grão" : "grãos"}`;

export function plansOf(s: AgentSettings) {
  return s.billingPlans ?? [];
}
export function planById(s: AgentSettings, id: string | null | undefined): BillingPlan | null {
  return plansOf(s).find((p) => p.id === id) ?? null;
}
export function packById(s: AgentSettings, id: string | null | undefined) {
  return (s.billingPacks ?? []).find((p) => p.id === id) ?? null;
}

/** Quem não gasta grãos: cobrança desligada, dono da stack ou pessoa liberada pelo dono. */
export function grainsExempt(user: { phone: string; billing_exempt?: boolean | null }, s: AgentSettings) {
  return !s.billingEnabled || isOwner(user.phone) || Boolean(user.billing_exempt);
}

/**
 * Período livre: nos primeiros billingTrialDays dias depois do cadastro a pessoa usa sem gastar grãos. Depois disso o uso
 * desconta dos grãos de presente e, quando acabam, a IA para (o painel continua). Devolve o fim do período, ou null fora dele.
 */
export function trialEndsAt(user: { created_at?: Date | string | null }, s: AgentSettings): Date | null {
  const days = Number(s.billingTrialDays ?? 0);
  if (!(days > 0) || !user.created_at) return null;
  const end = new Date(new Date(user.created_at).getTime() + days * 86_400_000);
  return end.getTime() > Date.now() ? end : null;
}

/** Já pagou alguma vez (mensalidade ou pacote)? Muda o texto do aviso e libera a aba Pagamentos. */
export async function hasPaid(userId: string) {
  const r = await one<{ paid: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM subscriptions WHERE user_id = $1 AND last_payment_at IS NOT NULL)
         OR EXISTS (SELECT 1 FROM grain_purchases WHERE user_id = $1 AND status = 'paid') AS paid`,
    [userId],
  );
  return Boolean(r?.paid);
}

/** Carteira da pessoa; na primeira vez nasce com os grãos de boas-vindas (uma vez só, mesmo apagando a carteira). */
export async function ensureWallet(userId: string, s?: AgentSettings): Promise<Wallet> {
  s ??= await getSettings();
  let w = await one("SELECT plan_grains, extra_grains FROM wallets WHERE user_id = $1", [userId]);
  if (!w) {
    const welcome = Math.max(0, Math.round(Number(s.billingWelcomeGrains ?? 0)));
    // numa transação só: quem cria a carteira é quem dá as boas-vindas. Duas chamadas ao mesmo tempo esperam a primeira
    // (o INSERT da carteira trava na linha nova) e a segunda não cria nada, então os grãos nunca se perdem no meio.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const born = await client.query("INSERT INTO wallets (user_id, welcome_at) VALUES ($1, now()) ON CONFLICT (user_id) DO NOTHING RETURNING user_id", [userId]);
      if (born.rowCount && welcome > 0) {
        // a entrada no extrato com ref fixa garante as boas-vindas uma vez só por pessoa (mesmo apagando a carteira)
        const first = await client.query(
          "INSERT INTO grain_ledger (user_id, delta, reason, ref) VALUES ($1, $2, 'boas-vindas', 'welcome') ON CONFLICT DO NOTHING RETURNING id",
          [userId, welcome],
        );
        if (first.rowCount) await client.query("UPDATE wallets SET extra_grains = $2 WHERE user_id = $1", [userId, welcome]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    w = await one("SELECT plan_grains, extra_grains FROM wallets WHERE user_id = $1", [userId]);
  }
  return { plan: Number(w!.plan_grains), extra: Number(w!.extra_grains), total: Number(w!.plan_grains) + Number(w!.extra_grains) };
}

export async function walletOf(userId: string, s?: AgentSettings) {
  return ensureWallet(userId, s);
}

/**
 * Põe grãos na carteira, uma vez por (motivo, ref): o mesmo pagamento chegando duas vezes do Asaas não credita duas vezes.
 * bucket "plan" com set=true recarrega o plano para exatamente `amount` (o que sobrou do mês não acumula).
 * Devolve null quando já tinha sido creditado.
 */
export async function creditGrains(
  userId: string,
  opts: { amount: number; bucket: "plan" | "extra"; reason: keyof typeof GRAIN_REASON; ref: string; note?: string; set?: boolean },
): Promise<Wallet | null> {
  await ensureWallet(userId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const w = (await client.query("SELECT plan_grains, extra_grains FROM wallets WHERE user_id = $1 FOR UPDATE", [userId])).rows[0];
    const amount = Math.max(0, Math.round(opts.amount));
    const delta = opts.bucket === "plan" && opts.set ? amount - Number(w.plan_grains) : amount;
    const logged = await client.query(
      "INSERT INTO grain_ledger (user_id, delta, reason, ref, note) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id",
      [userId, delta, opts.reason, opts.ref, opts.note ?? null],
    );
    if (!logged.rowCount) {
      await client.query("ROLLBACK");
      return null;
    }
    const col = opts.bucket === "plan" ? "plan_grains" : "extra_grains";
    const r = (
      await client.query(
        `UPDATE wallets SET ${col} = GREATEST(${col} + $2, 0), low_notice_at = NULL, empty_notice_at = NULL, updated_at = now()
          WHERE user_id = $1 RETURNING plan_grains, extra_grains`,
        [userId, delta],
      )
    ).rows[0];
    await client.query("COMMIT");
    return { plan: Number(r.plan_grains), extra: Number(r.extra_grains), total: Number(r.plan_grains) + Number(r.extra_grains) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Quantos grãos (com fração) custa um gasto de IA em dólares. O desconto inteiro sai quando as frações somam 1. */
export function grainsForCost(costUsd: number, s: AgentSettings) {
  if (!(costUsd > 0)) return 0;
  return costUsd * Number(s.billingGrainsPerUsd || 1500);
}

/** Abaixo disto a pessoa recebe um aviso: 20% do plano dela, ou 100 grãos sem plano. */
async function lowLine(userId: string, s: AgentSettings) {
  const sub = await one<{ plan_id: string | null; asaas_subscription_id: string | null; status: string }>("SELECT plan_id, asaas_subscription_id, status FROM subscriptions WHERE user_id = $1", [userId]);
  const plan = sub?.asaas_subscription_id && sub.status !== "canceled" ? planById(s, sub.plan_id) : null;
  return plan ? Math.max(20, Math.round(plan.grains * 0.2)) : 100;
}

/** Link da tela de grãos (comprar mais ou trocar de plano). */
export function grainsLink() {
  return `${config.PUBLIC_URL.replace(/\/$/, "")}/plano`;
}

/** Avisos de grãos no WhatsApp: título em negrito com emoji, o dado que importa em negrito e o link no fim (estilo do assistente). */
export const GRAIN_TEXT = {
  low: (left: number, link: string) =>
    `🌾 *Seus grãos estão acabando*\n\nSobraram *${grains(left)}* por aqui. Pra eu não parar no meio de nada, dá pra:\n• comprar um pacote avulso\n• ou subir de plano\n\nLeva um minutinho 👉 ${link}`,
  empty: (link: string) =>
    `⏸️ *Seus grãos acabaram*\n\nPausei por aqui 🙏 O painel continua aberto, e pra eu voltar a responder aqui e no chat do app é só comprar um pacote avulso ou subir de plano.\n\n👉 ${link}`,
  /** nunca pagou: o período grátis (dias livres + grãos de presente) acabou */
  freeOver: (link: string) =>
    `💜 *Seu período grátis acabou*\n\nFoi muito bom te ajudar nesses dias! O painel continua com você, e pra eu voltar a te ajudar aqui e no chat do app é só assinar um plano ou comprar grãos.\n\nLeva um minutinho 👉 ${link}`,
  trialOver: (days: number, left: number, link: string) =>
    `🎉 *Seus ${days} ${days === 1 ? "dia" : "dias"} de uso livre acabaram*\n\nDaqui pra frente cada pedido gasta grãos, e você ainda tem *${grains(left)} de presente* pra continuar.\n\nQuando acabarem, dá pra assinar um plano ou comprar mais 👉 ${link}`,
};

/** Texto puro para o sininho do painel e para o e-mail: sem *negrito*, _itálico_ nem ~riscado~ do WhatsApp. */
export const plainText = (t: string) => t.replace(/(^|[\s(])[*_~]([^*_~\n]+)[*_~](?=$|[\s.,!?:;)])/gm, "$1$2");

/** O mesmo aviso por e-mail (assunto e texto), que o fluxo "[Sistema] Planejai · Eventos" do n8n manda. */
export const GRAIN_EMAIL = {
  low: (left: number, link: string) => ({
    subject: "Seus grãos do Planejai estão acabando",
    text: `Oi! Sobraram ${grains(left)} na sua conta do Planejai.\n\nPara o assistente não parar no meio, dá para comprar um pacote avulso (com o cartão já cadastrado é um toque só) ou subir de plano:\n${link}\n\nEquipe Planejai`,
  }),
  empty: (link: string) => ({
    subject: "Seus grãos do Planejai acabaram",
    text: `Oi! Seus grãos acabaram, então o assistente pausou no WhatsApp e no chat do app. O painel continua aberto.\n\nPara ele voltar a responder, compre um pacote avulso (com o cartão já cadastrado é um toque só) ou suba de plano:\n${link}\n\nEquipe Planejai`,
  }),
  freeOver: (link: string) => ({
    subject: "Seu período grátis no Planejai acabou",
    text: `Oi! Seus grãos de presente acabaram, então o assistente pausou no WhatsApp e no chat do app. O painel continua aberto.\n\nPara ele voltar a te ajudar, é só assinar um plano ou comprar grãos. Leva um minutinho:\n${link}\n\nEquipe Planejai`,
  }),
};

/** Evento para o n8n com o e-mail da pessoa; sem e-mail cadastrado o evento sai igual (o fluxo só não manda nada). */
async function mailGrains(userId: string, event: "grains.low" | "grains.empty", mail: { subject: string; text: string }, extra: Record<string, unknown>) {
  try {
    const { emailFields, emailOf, emitEvent } = await import("./events.js");
    await emitEvent(event, { user_id: userId, link: grainsLink(), ...extra, ...emailFields(await emailOf(userId), mail.subject, mail.text) });
  } catch {
    /* aviso extra: o WhatsApp e o sininho já saíram */
  }
}

/** Fila de envio do WhatsApp + sininho do painel (o aviso não some se o número cair). */
export async function tellPerson(userId: string, text: string, kind = "assinatura", link = "/plano") {
  // sininho: sem a marcação do WhatsApp; o título é a primeira linha (o título do aviso) ou a primeira frase
  const plain = plainText(text);
  const title = plain.split("\n")[0]!.split(/(?<=[.!?:])\s/)[0]!.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  await notify({ userId, kind, title, body: plain, link });
  await (await getBoss()).send(QUEUES.outbound, { type: "send", userId, text }, { retryLimit: 2, retryDelay: 20 });
}

/**
 * Desconta o uso de IA. Chamado a cada passo com custo (trace.ts); soma no extrato do dia.
 * O custo vira grão com fração: soma com o resto guardado, desconta a parte inteira e guarda o novo resto (menor que 1).
 * Nunca deixa negativo: a resposta que já começou termina mesmo que o saldo zere no meio.
 * Avisa quando cruza a linha de "acabando" e quando zera (uma vez até a próxima recarga).
 */
export async function chargeUsage(userId: string, costUsd: number) {
  const s = await getSettings();
  if (!s.billingEnabled) return null;
  const exact = grainsForCost(costUsd, s);
  if (exact <= 0) return null;
  const user = await one("SELECT phone, billing_exempt, created_at, profile->>'trial_notice_at' AS trial_notice_at FROM users WHERE id = $1", [userId]);
  if (!user || grainsExempt(user, s)) return null;
  // período livre: não desconta nada
  if (trialEndsAt(user, s)) return null;
  const before = await ensureWallet(userId, s);
  // primeiro desconto depois do período livre (de quem saiu dele nesta semana): avisa uma vez que agora gasta grãos
  const days = Number(s.billingTrialDays ?? 0);
  if (days > 0 && !user.trial_notice_at && new Date(user.created_at).getTime() + days * 86_400_000 > Date.now() - 7 * 86_400_000) {
    const marked = await one(
      "UPDATE users SET profile = profile || jsonb_build_object('trial_notice_at', now()) WHERE id = $1 AND profile->>'trial_notice_at' IS NULL RETURNING id",
      [userId],
    );
    if (marked && before.total > 0) await tellPerson(userId, GRAIN_TEXT.trialOver(days, before.total, grainsLink())).catch(() => {});
  }
  // numa instrução só: o FOR UPDATE faz dois passos ao mesmo tempo esperarem um ao outro, então nenhuma fração se perde
  const r = await one(
    `WITH w AS (SELECT user_id, grain_remainder + $2::float8 AS acc, floor(grain_remainder + $2::float8 + 1e-9)::int AS amt
                  FROM wallets WHERE user_id = $1 FOR UPDATE)
     UPDATE wallets t SET grain_remainder = GREATEST(w.acc - w.amt, 0), plan_grains = GREATEST(t.plan_grains - w.amt, 0),
            extra_grains = GREATEST(t.extra_grains - GREATEST(w.amt - t.plan_grains, 0), 0), updated_at = now()
       FROM w WHERE t.user_id = w.user_id
     RETURNING w.amt, t.plan_grains, t.extra_grains, t.low_notice_at, t.empty_notice_at`,
    [userId, exact],
  );
  const amount = Number(r.amt);
  if (amount <= 0) return { charged: 0, left: Number(r.plan_grains) + Number(r.extra_grains) };
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: s.timezone || config.DEFAULT_TIMEZONE }).format(new Date());
  await query(
    `INSERT INTO grain_ledger (user_id, delta, reason, ref) VALUES ($1, $2, 'uso', $3)
     ON CONFLICT (user_id, reason, ref) WHERE ref IS NOT NULL DO UPDATE SET delta = grain_ledger.delta + EXCLUDED.delta, created_at = now()`,
    [userId, -amount, day],
  );
  const left = Number(r.plan_grains) + Number(r.extra_grains);
  if (left <= 0 && !r.empty_notice_at) {
    // o aviso de zerado sai na hora; a trava do orquestrador não repete hoje
    await query("UPDATE wallets SET empty_notice_at = now() WHERE user_id = $1", [userId]);
    await query("UPDATE users SET profile = profile || jsonb_build_object('billing_notice_at', now()) WHERE id = $1", [userId]);
    const paid = await hasPaid(userId);
    await tellPerson(userId, paid ? GRAIN_TEXT.empty(grainsLink()) : GRAIN_TEXT.freeOver(grainsLink())).catch(() => {});
    void mailGrains(userId, "grains.empty", paid ? GRAIN_EMAIL.empty(grainsLink()) : GRAIN_EMAIL.freeOver(grainsLink()), { paid });
  } else if (left > 0 && !r.low_notice_at) {
    const line = await lowLine(userId, s);
    if (before.total > line && left <= line) {
      await query("UPDATE wallets SET low_notice_at = now() WHERE user_id = $1", [userId]);
      await tellPerson(userId, GRAIN_TEXT.low(left, grainsLink())).catch(() => {});
      void mailGrains(userId, "grains.low", GRAIN_EMAIL.low(left, grainsLink()), { left });
    }
  }
  return { charged: amount, left };
}

let perMessageCache: { at: number; value: number | null } | null = null;

/**
 * Quantos grãos uma mensagem gasta em média, para a página de preços dizer "dá para umas N mensagens". Primeiro o que
 * saiu de verdade das carteiras nos últimos 30 dias ÷ mensagens dessas pessoas nesses dias; sem cobrança ligada ainda,
 * o custo real de IA × a taxa. Com pouca conversa (menos de 50 mensagens) não chuta: null. Guardado por uma hora.
 */
export async function grainsPerMessage(s: AgentSettings): Promise<number | null> {
  if (perMessageCache && Date.now() - perMessageCache.at < 3_600_000) return perMessageCache.value;
  const charged = await one<{ grains: number; msgs: number }>(
    `SELECT COALESCE(SUM(-g.delta), 0)::float AS grains, COALESCE(SUM(u.messages), 0)::float AS msgs
       FROM grain_ledger g JOIN usage_daily u ON u.user_id = g.user_id AND u.day::text = g.ref
      WHERE g.reason = 'uso' AND g.created_at > now() - interval '30 days'`,
  ).catch(() => null);
  const r = await one<{ cost: number; msgs: number }>(
    "SELECT COALESCE(SUM(cost_usd), 0)::float AS cost, COALESCE(SUM(messages), 0)::float AS msgs FROM usage_daily WHERE day > current_date - 30",
  ).catch(() => null);
  const value =
    charged && charged.msgs >= 50 && charged.grains > 0
      ? Math.max(0.1, charged.grains / charged.msgs)
      : r && r.msgs >= 50 && r.cost > 0
        ? Math.max(0.1, (r.cost / r.msgs) * Number(s.billingGrainsPerUsd || 1500))
        : null;
  perMessageCache = { at: Date.now(), value };
  return value;
}

/** Extrato recente (as entradas de uso já vêm somadas por dia). */
export async function ledgerOf(userId: string, limit = 30) {
  const rows = await many(
    "SELECT delta, reason, ref, note, created_at FROM grain_ledger WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
    [userId, limit],
  );
  return rows.map((r) => ({ delta: Number(r.delta), reason: r.reason, label: GRAIN_REASON[r.reason] ?? r.reason, note: r.note, day: r.reason === "uso" ? r.ref : null, at: r.created_at }));
}

/** Média de grãos por dia nos últimos 14 dias de uso (para "dá para mais ou menos N dias"). */
export async function dailyBurn(userId: string) {
  const r = await one<{ g: number; d: number }>(
    `SELECT COALESCE(-SUM(delta), 0)::float AS g, COUNT(*)::int AS d FROM grain_ledger
      WHERE user_id = $1 AND reason = 'uso' AND created_at > now() - interval '14 days'`,
    [userId],
  );
  return r && r.d > 0 ? r.g / r.d : 0;
}
