import { getSubscription, hasPlan, savedCardOf } from "./billing.js";
import { dailyBurn, grainsExempt, ledgerOf, planById, trialEndsAt } from "./credits.js";
import { config } from "./config.js";
import { many, one } from "./db/pool.js";
import { INTEGRATIONS } from "./integrations/registry.js";
import { getSettings } from "./settings.js";

/**
 * Ficha do cliente em Pessoas (só super admin): plano e grãos, uso por dia, como ele usa e o que usa no app.
 * Só números e nomes de recursos, nunca o conteúdo (gastos, mensagens e memórias são dele).
 */

/** Plano, grãos e próxima cobrança, sem efeito colateral (não cria carteira nem dá boas-vindas só por abrir a ficha). */
export async function clientBilling(userId: string) {
  const s = await getSettings();
  const user = await one("SELECT id, phone, billing_exempt, created_at FROM users WHERE id = $1", [userId]);
  if (!user) return null;
  const [wallet, sub, burn, ledger, packs] = await Promise.all([
    one("SELECT plan_grains, extra_grains, welcome_at, low_notice_at, empty_notice_at FROM wallets WHERE user_id = $1", [userId]),
    getSubscription(userId),
    dailyBurn(userId),
    ledgerOf(userId, 15),
    one<{ n: number; v: number }>("SELECT COUNT(*)::int AS n, COALESCE(SUM(value), 0)::float AS v FROM grain_purchases WHERE user_id = $1 AND status = 'paid'", [userId]),
  ]);
  // sem carteira ainda: vale o presente de boas-vindas que ela vai ganhar na primeira mensagem
  const planGrains = wallet ? Number(wallet.plan_grains) : 0;
  const extraGrains = wallet ? Number(wallet.extra_grains) : Number(s.billingWelcomeGrains ?? 0);
  const total = planGrains + extraGrains;
  const active = hasPlan(sub);
  const plan = active ? planById(s, sub.plan_id) : null;
  const nextPlan = active ? planById(s, sub.next_plan_id) : null;
  const trial = trialEndsAt(user, s);
  const state = !s.billingEnabled
    ? "off"
    : grainsExempt(user, s)
      ? "exempt"
      : active && sub.status === "overdue"
        ? "overdue"
        : active
          ? "plan"
          : trial
            ? "trial"
            : total > 0
              ? "free"
              : "empty";
  return {
    enabled: Boolean(s.billingEnabled),
    state,
    trialUntil: trial?.toISOString() ?? null,
    // linha do tempo: cadastro, fim do período livre (daí em diante gasta os grãos de boas-vindas) e o plano
    trialDays: Number(s.billingTrialDays ?? 0),
    trialEndsAt: Number(s.billingTrialDays ?? 0) > 0 ? new Date(new Date(user.created_at).getTime() + Number(s.billingTrialDays) * 86_400_000).toISOString() : null,
    welcomeGrains: Number(s.billingWelcomeGrains ?? 0),
    welcomeAt: wallet?.welcome_at ?? null,
    notices: { low: wallet?.low_notice_at ?? null, empty: wallet?.empty_notice_at ?? null },
    savedCard: savedCardOf(sub),
    grainsPerUsd: Number(s.billingGrainsPerUsd || 1500),
    wallet: { plan: planGrains, extra: extraGrains, total, created: Boolean(wallet) },
    burnPerDay: Math.round(burn),
    // no ritmo dos últimos 14 dias: quantos dias o saldo ainda dura
    daysLeft: burn > 0 ? Math.floor(total / burn) : null,
    subscription: sub
      ? {
          active,
          status: sub.status,
          plan: plan && { name: plan.name, grains: plan.grains, price: plan.price },
          nextPlan: nextPlan && { name: nextPlan.name },
          value: Number(sub.value ?? 0),
          baseValue: sub.base_value == null ? null : Number(sub.base_value),
          discount: Number(sub.discount_percent ?? 0),
          method: sub.pay_method ?? sub.last_billing_type ?? null,
          card: sub.card_last4 ? { brand: sub.card_brand, last4: sub.card_last4 } : null,
          // cartão renova sozinho todo mês; Pix/boleto gera a cobrança e eu lembro antes de vencer
          autoRenew: active && sub.status !== "canceled" && (sub.pay_method === "card" || sub.last_billing_type === "CREDIT_CARD"),
          nextDueDate: sub.next_due_date,
          paidUntil: sub.paid_until,
          lastPaymentAt: sub.last_payment_at,
          since: (sub as { created_at?: string | Date }).created_at ?? null,
          invoiceUrl: /^https:\/\/([a-z0-9-]+\.)*asaas\.com\//i.test(String(sub.invoice_url ?? "")) ? sub.invoice_url : null,
        }
      : null,
    packs: { count: packs?.n ?? 0, value: packs?.v ?? 0 },
    ledger,
  };
}

/** Uso por dia no período (usage_daily fica mesmo depois que as execuções somem): mensagens, respostas, custo e grãos. */
export async function clientDaily(userId: string, days: number) {
  const s = await getSettings();
  const rate = Number(s.billingGrainsPerUsd || 1500);
  const rows = await many(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(u.messages, 0)::int AS messages, COALESCE(u.executions, 0)::int AS executions,
            COALESCE(u.cost_usd, 0)::float AS cost, COALESCE(u.tokens_in + u.tokens_out, 0)::float AS tokens,
            g.charged
       FROM generate_series(current_date - ($2::int - 1), current_date, interval '1 day') d
       LEFT JOIN usage_daily u ON u.user_id = $1 AND u.day = d::date
       LEFT JOIN LATERAL (SELECT -SUM(delta)::int AS charged FROM grain_ledger WHERE user_id = $1 AND reason = 'uso' AND ref = to_char(d, 'YYYY-MM-DD')) g ON true
      ORDER BY d`,
    [userId, days],
  );
  // grãos: o que foi descontado de verdade; quem não paga (dono, liberado, cobrança desligada) vê o equivalente pelo custo
  return rows.map((r) => ({ ...r, grains: r.charged != null ? Number(r.charged) : Math.ceil(r.cost * rate - 1e-9), charged: r.charged != null }));
}

/** Como a pessoa usa: desde quando, quantos dias ativos, horário preferido, canais, tempo de resposta e acesso ao painel. */
export async function clientActivity(userId: string) {
  const s = await getSettings();
  const tz = s.timezone || config.DEFAULT_TIMEZONE;
  const [base, hours, channels, panel, push] = await Promise.all([
    one(
      `SELECT u.created_at, u.last_seen_at,
              (SELECT MIN(day) FROM usage_daily WHERE user_id = $1 AND messages > 0) AS first_day,
              (SELECT COUNT(*)::int FROM usage_daily WHERE user_id = $1 AND messages > 0 AND day > current_date - 30) AS active_days_30,
              (SELECT COALESCE(SUM(messages), 0)::int FROM usage_daily WHERE user_id = $1 AND day > current_date - 30) AS messages_30,
              (SELECT COALESCE(SUM(messages), 0)::int FROM usage_daily WHERE user_id = $1) AS messages_total,
              (SELECT COALESCE(SUM(executions), 0)::int FROM usage_daily WHERE user_id = $1) AS executions_total,
              (SELECT AVG(duration_ms)::float FROM executions WHERE user_id = $1 AND duration_ms IS NOT NULL AND started_at > now() - interval '7 days') AS avg_ms
         FROM users u WHERE u.id = $1`,
      [userId],
    ),
    many(
      `SELECT EXTRACT(hour FROM started_at AT TIME ZONE $2)::int AS h, COUNT(*)::int AS n FROM executions
        WHERE user_id = $1 AND started_at > now() - interval '7 days' GROUP BY 1`,
      [userId, tz],
    ).catch(() => []),
    many("SELECT DISTINCT channel FROM conversations WHERE user_id = $1", [userId]).catch(() => []),
    one(
      `SELECT MAX(d.last_seen_at) AS last_at, COUNT(d.*)::int AS devices FROM accounts a LEFT JOIN login_devices d ON d.account_id = a.id::text
        WHERE a.user_id = $1`,
      [userId],
    ).catch(() => null),
    one<{ n: number }>("SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = $1", [userId]).catch(() => null),
  ]);
  const byHour = Array.from({ length: 24 }, (_, h) => hours.find((r) => r.h === h)?.n ?? 0);
  const peak = byHour.some((n) => n > 0) ? byHour.indexOf(Math.max(...byHour)) : null;
  return {
    since: base?.created_at ?? null,
    lastSeenAt: base?.last_seen_at ?? null,
    firstDay: base?.first_day ?? null,
    activeDays30: base?.active_days_30 ?? 0,
    messages30: base?.messages_30 ?? 0,
    messagesTotal: base?.messages_total ?? 0,
    executionsTotal: base?.executions_total ?? 0,
    avgResponseMs: base?.avg_ms == null ? null : Math.round(base.avg_ms),
    byHour,
    peakHour: peak,
    channels: channels.map((c) => String(c.channel)),
    panelLastAt: panel?.last_at ?? null,
    panelDevices: panel?.devices ?? 0,
    pushDevices: push?.n ?? 0,
  };
}

const count = (sql: string, userId: string) => one<{ n: number }>(sql, [userId]).then((r) => r?.n ?? 0, () => 0);

/** O que a pessoa tem no app, por área (só contagens). Cada consulta falha sozinha sem derrubar a ficha. */
export async function clientFeatures(userId: string) {
  const [transactionsMonth, transactions, budgets, bills, cards, goals, reminders, alarms, watches, documents, phonebook, contacts, errands, shopping, meetings, memories, automations, integrations] =
    await Promise.all([
      count("SELECT COUNT(*)::int AS n FROM transactions WHERE user_id = $1 AND created_at > date_trunc('month', now())", userId),
      count("SELECT COUNT(*)::int AS n FROM transactions WHERE user_id = $1", userId),
      count("SELECT COUNT(*)::int AS n FROM budgets WHERE user_id = $1", userId),
      count("SELECT COUNT(*)::int AS n FROM bills WHERE user_id = $1 AND active", userId),
      count("SELECT COUNT(*)::int AS n FROM cards WHERE user_id = $1 AND active", userId),
      count("SELECT COUNT(*)::int AS n FROM finance_goals WHERE user_id = $1 AND done_at IS NULL", userId),
      count("SELECT COUNT(*)::int AS n FROM reminders WHERE user_id = $1 AND status = 'scheduled'", userId),
      count("SELECT COUNT(*)::int AS n FROM alarms WHERE user_id = $1 AND status = 'scheduled'", userId),
      count("SELECT COUNT(*)::int AS n FROM watches WHERE user_id = $1 AND status = 'active'", userId),
      count("SELECT COUNT(*)::int AS n FROM documents WHERE user_id = $1", userId),
      count("SELECT COUNT(*)::int AS n FROM phonebook WHERE user_id = $1", userId),
      count("SELECT COUNT(*)::int AS n FROM contacts WHERE user_id = $1", userId),
      count("SELECT COUNT(*)::int AS n FROM errands WHERE user_id = $1", userId),
      count("SELECT COUNT(*)::int AS n FROM shopping_items WHERE user_id = $1 AND bought_at IS NULL", userId),
      count("SELECT COUNT(*)::int AS n FROM meet_sessions WHERE user_id = $1", userId),
      count("SELECT COUNT(*)::int AS n FROM memories WHERE user_id = $1", userId),
      count("SELECT COUNT(*)::int AS n FROM automations WHERE user_id = $1 AND active", userId),
      many("SELECT integration_id FROM user_integrations WHERE user_id = $1 ORDER BY connected_at", [userId]).catch(() => []),
    ]);
  const names = new Map(INTEGRATIONS.map((d) => [d.id, d.name]));
  return {
    transactionsMonth,
    transactions,
    budgets,
    bills,
    cards,
    goals,
    reminders,
    alarms,
    watches,
    documents,
    phonebook,
    contacts,
    errands,
    shopping,
    meetings,
    memories,
    automations,
    integrations: integrations.map((r) => names.get(r.integration_id) ?? r.integration_id),
  };
}
