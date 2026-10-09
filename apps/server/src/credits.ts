import { config } from "./config.js";
import { many, one, pool, query } from "./db/pool.js";
import { isOwner } from "./ingest.js";
import { notify } from "./notifications.js";
import { QUEUES, getBoss } from "./queue/boss.js";
import { type AgentSettings, type BillingPlan, getSettings } from "./settings.js";

/**
 * Grãos: o crédito do Planejai. O assistente gasta grãos conforme o custo real de IA de cada resposta
 * (custo do OpenRouter × billingGrainsPerUsd, arredondado para cima). A carteira tem dois bolsos:
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

/** Carteira da pessoa; na primeira vez nasce com os grãos de boas-vindas (uma vez só, mesmo apagando a carteira). */
export async function ensureWallet(userId: string, s?: AgentSettings): Promise<Wallet> {
  s ??= await getSettings();
  let w = await one("SELECT plan_grains, extra_grains FROM wallets WHERE user_id = $1", [userId]);
  if (!w) {
    const welcome = Math.max(0, Math.round(Number(s.billingWelcomeGrains ?? 0)));
    // a entrada no extrato com ref fixa garante as boas-vindas uma vez só por pessoa
    const first = welcome > 0
      ? await one("INSERT INTO grain_ledger (user_id, delta, reason, ref) VALUES ($1, $2, 'boas-vindas', 'welcome') ON CONFLICT DO NOTHING RETURNING id", [userId, welcome])
      : null;
    await query("INSERT INTO wallets (user_id, extra_grains, welcome_at) VALUES ($1, $2, now()) ON CONFLICT (user_id) DO NOTHING", [userId, first ? welcome : 0]);
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

/** Quantos grãos custa um gasto de IA em dólares (sempre para cima: nenhuma resposta sai de graça sem querer). */
export function grainsForCost(costUsd: number, s: AgentSettings) {
  if (!(costUsd > 0)) return 0;
  return Math.ceil(costUsd * Number(s.billingGrainsPerUsd || 1000) - 1e-9);
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

export const GRAIN_TEXT = {
  low: (left: number, link: string) =>
    `Seus grãos estão acabando: sobraram ${grains(left)}. Para eu não parar no meio, dá para comprar um pacote avulso ou subir de plano aqui: ${link}`,
  empty: (link: string) =>
    `Seus grãos acabaram, então pausei por aqui 🙏 É só comprar um pacote avulso ou subir de plano e eu volto na hora: ${link}`,
};

/** Fila de envio do WhatsApp + sininho do painel (o aviso não some se o número cair). */
export async function tellPerson(userId: string, text: string, kind = "assinatura", link = "/plano") {
  await notify({ userId, kind, title: text.split(/(?<=[.!?:])\s/)[0]!, body: text, link });
  await (await getBoss()).send(QUEUES.outbound, { type: "send", userId, text }, { retryLimit: 2, retryDelay: 20 });
}

/**
 * Desconta o uso de IA. Chamado a cada passo com custo (trace.ts); soma no extrato do dia.
 * Nunca deixa negativo: a resposta que já começou termina mesmo que o saldo zere no meio.
 * Avisa quando cruza a linha de "acabando" e quando zera (uma vez até a próxima recarga).
 */
export async function chargeUsage(userId: string, costUsd: number) {
  const s = await getSettings();
  if (!s.billingEnabled) return null;
  const amount = grainsForCost(costUsd, s);
  if (amount <= 0) return null;
  const user = await one("SELECT phone, billing_exempt FROM users WHERE id = $1", [userId]);
  if (!user || grainsExempt(user, s)) return null;
  const before = await ensureWallet(userId, s);
  const r = await one(
    `UPDATE wallets SET plan_grains = GREATEST(plan_grains - $2, 0),
            extra_grains = GREATEST(extra_grains - GREATEST($2 - plan_grains, 0), 0), updated_at = now()
      WHERE user_id = $1 RETURNING plan_grains, extra_grains, low_notice_at, empty_notice_at`,
    [userId, amount],
  );
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
    await tellPerson(userId, GRAIN_TEXT.empty(grainsLink())).catch(() => {});
  } else if (left > 0 && !r.low_notice_at) {
    const line = await lowLine(userId, s);
    if (before.total > line && left <= line) {
      await query("UPDATE wallets SET low_notice_at = now() WHERE user_id = $1", [userId]);
      await tellPerson(userId, GRAIN_TEXT.low(left, grainsLink())).catch(() => {});
    }
  }
  return { charged: amount, left };
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
