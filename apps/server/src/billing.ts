import { config } from "./config.js";
import { emitEvent } from "./events.js";
import { QUEUES, getBoss } from "./queue/boss.js";
import { many, one, query } from "./db/pool.js";
import { isOwner } from "./ingest.js";
import { getCredentials } from "./integrations/registry.js";
import { notify } from "./notifications.js";
import { getSettings, type AgentSettings } from "./settings.js";

/**
 * Assinatura mensal pelo Asaas. O dono liga em Configurações > Assinatura e cola a chave em Integrações > Asaas.
 * Cada pessoa tem alguns dias grátis (billingTrialDays) e depois precisa de uma assinatura em dia para o assistente responder.
 *
 * Dados de pagamento nunca passam por aqui: a cobrança é criada com forma de pagamento em aberto e a pessoa paga
 * na página do próprio Asaas (Pix, cartão ou boleto). O CPF/CNPJ vai para o Asaas e não fica guardado no nosso banco.
 * O Asaas avisa o que aconteceu pelo webhook (/webhooks/asaas), que é quem muda o status aqui.
 */

export type SubStatus = "trial" | "active" | "overdue" | "canceled";

export interface SubscriptionRow {
  user_id: string;
  asaas_customer_id: string;
  asaas_subscription_id: string | null;
  status: SubStatus;
  value: number;
  next_due_date: string | null;
  paid_until: string | null;
  last_payment_at: string | null;
  invoice_url: string | null;
  last_billing_type?: string | null;
  reminded_on?: string | null;
}

/** Depois do vencimento o Asaas ainda leva um tempo para avisar (Pix e boleto compensam no dia): folga antes de travar. */
const GRACE_DAYS = 2;
const DAY = 86_400_000;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const onlyDigits = (s: unknown) => String(s ?? "").replace(/\D/g, "");

/** CPF ou CNPJ com dígitos verificadores certos (o Asaas recusa documento inválido; melhor avisar antes). */
export function validCpfCnpj(raw: string) {
  const d = onlyDigits(raw);
  if (/^(\d)\1+$/.test(d)) return false;
  const check = (base: string, weights: number[]) => {
    const sum = weights.reduce((acc, w, i) => acc + Number(base[i]) * w, 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  if (d.length === 11) {
    const a = check(d, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
    const b = check(d, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    return a === Number(d[9]) && b === Number(d[10]);
  }
  if (d.length === 14) {
    const a = check(d, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    const b = check(d, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    return a === Number(d[12]) && b === Number(d[13]);
  }
  return false;
}

/** Chave de produção começa com $aact_prod_; qualquer outra (homologação) fala com o sandbox. */
export function asaasBase(apiKey: string) {
  return apiKey.startsWith("$aact_prod_") ? "https://api.asaas.com/v3" : "https://api-sandbox.asaas.com/v3";
}

async function asaas(method: string, path: string, body?: unknown) {
  const c = await getCredentials("asaas");
  if (!c?.api_key) throw new Error("Asaas não conectado (Integrações > Asaas)");
  const res = await fetch(`${asaasBase(c.api_key)}${path}`, {
    method,
    headers: { access_token: c.api_key, "User-Agent": "planejai", accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = (json?.errors ?? []).map((e: any) => e?.description).filter(Boolean).join("; ");
    throw new Error(why || `Asaas respondeu ${res.status}`);
  }
  return json;
}

export interface Plan {
  enabled: boolean;
  name: string;
  price: number;
  trialDays: number;
}

export function planOf(s: AgentSettings): Plan {
  return { enabled: Boolean(s.billingEnabled), name: s.billingPlanName, price: Number(s.billingPrice), trialDays: Number(s.billingTrialDays) };
}

export async function getSubscription(userId: string) {
  // datas como texto AAAA-MM-DD: são dias de calendário, sem fuso
  return one<SubscriptionRow>("SELECT *, to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date, to_char(paid_until, 'YYYY-MM-DD') AS paid_until FROM subscriptions WHERE user_id = $1", [userId]);
}

/** Fim dos dias grátis: contam de quando a pessoa entrou ou de quando a cobrança foi ligada, o que for mais recente. */
export function trialEnd(user: { created_at: string | Date; terms_accepted_at?: string | Date | null }, s: AgentSettings) {
  const joined = new Date(user.terms_accepted_at ?? user.created_at).getTime();
  const started = s.billingStartedAt ? new Date(s.billingStartedAt).getTime() : 0;
  return new Date(Math.max(joined, started) + Number(s.billingTrialDays) * DAY);
}

export type Access =
  | { allowed: true; state: "off" | "exempt" | "trial" | "active" | "paid_until"; until?: Date }
  | { allowed: false; state: "trial_ended" | "overdue"; invoiceUrl?: string | null };

/** A pessoa pode usar o assistente agora? Regra única, usada pelo assistente e pela tela de assinatura. */
export async function billingAccess(user: any, s?: AgentSettings): Promise<Access> {
  s ??= await getSettings();
  if (!s.billingEnabled) return { allowed: true, state: "off" };
  if (isOwner(user.phone) || user.billing_exempt) return { allowed: true, state: "exempt" };
  const sub = await getSubscription(user.id);
  const now = Date.now();
  const paidUntil = sub?.paid_until ? new Date(sub.paid_until).getTime() + (GRACE_DAYS + 1) * DAY : 0;
  if (sub?.status === "active") return { allowed: true, state: "active", until: sub.next_due_date ? new Date(sub.next_due_date) : undefined };
  // cancelou ou atrasou, mas o mês que já pagou vale até o fim
  if (paidUntil > now) return { allowed: true, state: "paid_until", until: new Date(sub!.paid_until!) };
  if (sub?.status === "overdue") return { allowed: false, state: "overdue", invoiceUrl: sub.invoice_url };
  const end = trialEnd(user, s);
  // já assinou e a primeira cobrança ainda não venceu (ou venceu agora há pouco e o aviso de pagamento está a caminho)
  if (sub?.status === "trial" && sub.next_due_date && new Date(sub.next_due_date).getTime() + (GRACE_DAYS + 1) * DAY > now) return { allowed: true, state: "trial", until: new Date(sub.next_due_date) };
  if (end.getTime() > now) return { allowed: true, state: "trial", until: end };
  return { allowed: false, state: sub?.status === "trial" ? "overdue" : "trial_ended", invoiceUrl: sub?.invoice_url };
}

export function billingLink() {
  return `${config.PUBLIC_URL.replace(/\/$/, "")}/assinatura`;
}

/** Texto para a pessoa quando o assistente está travado por falta de assinatura. */
export function blockedMessage(a: Extract<Access, { allowed: false }>, plan: Plan) {
  if (a.state === "overdue")
    return `Sua assinatura do ${plan.name} está com o pagamento pendente, então pausei por aqui 🙏 É só acertar e eu volto na hora: ${a.invoiceUrl ?? billingLink()}`;
  return `Seus ${plan.trialDays} dias grátis acabaram 🙏 Para eu continuar te ajudando, é só assinar o ${plan.name} (Pix, cartão ou boleto): ${billingLink()}`;
}

/** Cria o cliente e a assinatura mensal no Asaas; a primeira cobrança vence quando os dias grátis acabam. */
export async function subscribe(user: any, input: { name: string; cpfCnpj: string; email?: string | null }) {
  const s = await getSettings();
  const plan = planOf(s);
  if (!plan.enabled) throw new Error("A assinatura ainda não está ligada.");
  const name = String(input.name ?? "").trim().slice(0, 100);
  if (name.split(/\s+/).length < 2) throw new Error("Informe o nome completo.");
  if (!validCpfCnpj(input.cpfCnpj)) throw new Error("CPF ou CNPJ inválido.");
  const existing = await getSubscription(user.id);
  if (existing?.asaas_subscription_id && existing.status !== "canceled") throw new Error("Você já tem uma assinatura.");

  let customerId = existing?.asaas_customer_id;
  if (!customerId) {
    const customer = await asaas("POST", "/customers", {
      name,
      cpfCnpj: onlyDigits(input.cpfCnpj),
      email: input.email?.trim() || undefined,
      mobilePhone: String(user.phone).replace(/^55/, ""),
      externalReference: user.id,
      // os lembretes de cobrança saem por nós (o assistente já fala com a pessoa)
      notificationDisabled: true,
    });
    customerId = String(customer.id);
  }
  // quem ainda está nos dias grátis só é cobrado quando eles acabam; quem já passou paga hoje
  const end = trialEnd(user, s);
  const due = end.getTime() > Date.now() ? end : new Date();
  const created = await asaas("POST", "/subscriptions", {
    customer: customerId,
    billingType: "UNDEFINED",
    value: plan.price,
    nextDueDate: isoDay(due),
    cycle: "MONTHLY",
    description: plan.name,
    externalReference: user.id,
  });
  const first = (await asaas("GET", `/subscriptions/${created.id}/payments`).catch(() => null))?.data?.[0];
  const row = await one<SubscriptionRow>(
    `INSERT INTO subscriptions (user_id, asaas_customer_id, asaas_subscription_id, status, value, next_due_date, invoice_url)
     VALUES ($1, $2, $3, 'trial', $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET asaas_customer_id = $2, asaas_subscription_id = $3, status = 'trial', value = $4, next_due_date = $5, invoice_url = $6, updated_at = now()
     RETURNING *`,
    [user.id, customerId, String(created.id), plan.price, isoDay(due), first?.invoiceUrl ?? null],
  );
  await notify({ userId: null, kind: "assinatura", title: `${user.full_name ?? user.name ?? "+" + user.phone} assinou o ${plan.name}`, link: "/settings" });
  return row!;
}

/** Cancela no Asaas. O mês que já foi pago continua valendo até o fim. */
export async function cancelSubscription(userId: string) {
  const sub = await getSubscription(userId);
  if (!sub?.asaas_subscription_id || sub.status === "canceled") throw new Error("Não há assinatura para cancelar.");
  await asaas("DELETE", `/subscriptions/${sub.asaas_subscription_id}`).catch((e: Error) => {
    // já não existe do lado do Asaas: segue e marca como cancelada aqui
    if (!/404|não encontrad|not found/i.test(e.message)) throw e;
  });
  await query("UPDATE subscriptions SET status = 'canceled', invoice_url = NULL, updated_at = now() WHERE user_id = $1", [userId]);
}

const addMonth = (isoDate: string) => {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return isoDay(d);
};

const brl = (n: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n).replace(/\u00a0/g, " ");
const ddmm = (iso?: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "");

/** Mensagem para a pessoa no WhatsApp. O webhook roda na API e quem segura o WhatsApp é o worker: vai pela fila de envios. */
async function tell(userId: string, text: string) {
  await (await getBoss()).send(QUEUES.outbound, { type: "send", userId, text }, { retryLimit: 2, retryDelay: 20 });
}

/** Mensagens que cada evento do Asaas manda para a pessoa (sem IA: texto fixo, zero token). */
export const BILLING_TEXT = {
  firstPayment: (plan: string, value: number, next: string) =>
    `Pagamento de ${brl(value)} confirmado, obrigado por assinar o ${plan}! Tá tudo liberado. A próxima mensalidade vence dia ${ddmm(next)}.`,
  renewed: (value: number, next: string) => `Recebi o pagamento de ${brl(value)} da sua assinatura, obrigado! A próxima vence dia ${ddmm(next)}.`,
  unblocked: (value: number) => `Pagamento de ${brl(value)} confirmado e voltei a funcionar por aqui. Pode me mandar o que precisar!`,
  overdue: (value: number, link: string) => `A mensalidade de ${brl(value)} venceu e ainda não apareceu aqui. Dá para pagar por Pix, cartão ou boleto: ${link}`,
  dueSoon: (value: number, days: number, due: string, link: string) =>
    `${days === 0 ? "Hoje vence" : days === 1 ? "Amanhã vence" : `Dia ${ddmm(due)} vence`} a sua mensalidade de ${brl(value)}. Se quiser já deixar pago: ${link}`,
  canceled: (until: string | null) =>
    until ? `Sua assinatura foi cancelada. O que já foi pago vale até dia ${ddmm(until)}, e dá para voltar quando quiser.` : "Sua assinatura foi cancelada. Dá para voltar quando quiser.",
  trialEnding: (plan: string, value: number, link: string) =>
    `Amanhã acabam seus dias grátis. Para eu continuar te ajudando, é só assinar o ${plan} por ${brl(value)} por mês (Pix, cartão ou boleto): ${link}`,
  referral: (name: string, percent: number) =>
    `${name} assinou pelo seu convite, então você ganhou ${percent}% de desconto na próxima mensalidade. Obrigado por indicar!`,
};

/** Evento já tratado? O Asaas reenvia quando não recebe 200; cada evento só vira mensagem uma vez. Sem id nenhum, não dá para saber. */
function eventKey(body: any) {
  if (body?.id) return String(body.id);
  const p = body?.payment ?? {};
  return p.id ? `${body?.event}:${p.id}:${p.status ?? ""}` : null;
}

/**
 * Evento do Asaas. Só mexe em assinatura que criamos (casa pelo id da assinatura).
 * Pagamento confirmado libera até o próximo vencimento; vencido trava; assinatura apagada vira cancelada.
 * Cada mudança avisa a pessoa no WhatsApp (o Asaas não manda nada: o cliente é criado com notificationDisabled)
 * e vira evento para o n8n (payment.confirmed, payment.overdue, subscription.canceled).
 */
export async function handleAsaasEvent(body: any): Promise<{ handled: boolean; status?: SubStatus; duplicate?: boolean }> {
  const event = String(body?.event ?? "");
  const subId = body?.payment?.subscription ?? body?.subscription?.id;
  if (!subId) return { handled: false };
  const sub = await one<SubscriptionRow>("SELECT *, to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date, to_char(paid_until, 'YYYY-MM-DD') AS paid_until FROM subscriptions WHERE asaas_subscription_id = $1", [String(subId)]);
  if (!sub) return { handled: false };
  const key = eventKey(body);
  if (key && (await one("SELECT 1 FROM asaas_events WHERE id = $1", [key]))) return { handled: true, duplicate: true, status: sub.status };
  const r = await applyAsaasEvent(event, body, sub);
  // marca só depois de dar certo: se falhar, o 500 faz o Asaas mandar de novo
  if (key) await query("INSERT INTO asaas_events (id, event) VALUES ($1, $2) ON CONFLICT DO NOTHING", [key, event]);
  return r;
}

async function applyAsaasEvent(event: string, body: any, sub: SubscriptionRow): Promise<{ handled: boolean; status?: SubStatus }> {
  const p = body.payment ?? {};
  const value = Number(p.value ?? sub.value);
  const set = async (status: SubStatus, extra: Record<string, unknown> = {}) => {
    const cols = Object.keys(extra);
    await query(
      `UPDATE subscriptions SET status = $2${cols.map((c, i) => `, ${c} = $${i + 3}`).join("")}, updated_at = now() WHERE user_id = $1`,
      [sub.user_id, status, ...Object.values(extra)],
    );
    return { handled: true, status };
  };
  switch (event) {
    case "PAYMENT_CONFIRMED":
    case "PAYMENT_RECEIVED":
    case "PAYMENT_RECEIVED_IN_CASH": {
      const due = String(p.dueDate ?? isoDay(new Date()));
      const next = addMonth(due);
      // cartão manda CONFIRMED e depois RECEIVED do mesmo pagamento: só o primeiro avisa
      const already = sub.status === "active" && sub.paid_until === next;
      const first = !sub.last_payment_at;
      const wasBlocked = sub.status === "overdue";
      const r = await set("active", { paid_until: next, next_due_date: next, last_payment_at: new Date().toISOString(), invoice_url: null, last_billing_type: p.billingType ?? null });
      if (wasBlocked) await query("UPDATE users SET profile = profile - 'billing_notice_at' WHERE id = $1", [sub.user_id]);
      if (already) return r;
      const plan = planOf(await getSettings());
      await tell(sub.user_id, wasBlocked ? BILLING_TEXT.unblocked(value) : first ? BILLING_TEXT.firstPayment(plan.name, value, next) : BILLING_TEXT.renewed(value, next));
      void emitEvent("payment.confirmed", { user_id: sub.user_id, value, billing_type: p.billingType ?? null, first, next_due_date: next, payment_id: p.id ?? null });
      if (first) await creditReferral(sub.user_id).catch((err) => console.error("[indicação]", err));
      return r;
    }
    case "PAYMENT_CREATED":
    case "PAYMENT_UPDATED":
      // a próxima cobrança do mês: guarda o link para a pessoa pagar e aplica desconto de indicação que esteja esperando
      if (p.status === "PENDING" || p.status === "OVERDUE") {
        await query("UPDATE subscriptions SET invoice_url = $2, next_due_date = COALESCE($3, next_due_date), updated_at = now() WHERE user_id = $1", [sub.user_id, p.invoiceUrl ?? null, p.dueDate ?? null]);
        if (event === "PAYMENT_CREATED" && p.status === "PENDING" && p.id) await applyReferralCredits(sub.user_id, p).catch((err) => console.error("[indicação]", err));
      }
      return { handled: true, status: sub.status };
    case "PAYMENT_OVERDUE": {
      const link = p.invoiceUrl ?? sub.invoice_url ?? billingLink();
      const r = await set("overdue", { invoice_url: link });
      // já avisou com o link: a trava do assistente não repete hoje
      await query("UPDATE users SET profile = profile || jsonb_build_object('billing_notice_at', now()) WHERE id = $1", [sub.user_id]);
      await tell(sub.user_id, BILLING_TEXT.overdue(value, link));
      void emitEvent("payment.overdue", { user_id: sub.user_id, value, invoice_url: link, due_date: p.dueDate ?? null });
      return r;
    }
    case "PAYMENT_REFUNDED":
    case "PAYMENT_CHARGEBACK_REQUESTED": {
      const r = await set("overdue", { paid_until: null });
      await notify({ userId: null, kind: "assinatura", title: event === "PAYMENT_REFUNDED" ? "Pagamento estornado" : "Contestação no cartão", body: `${brl(value)}. A pessoa fica travada até pagar de novo.`, link: "/settings" });
      return r;
    }
    case "SUBSCRIPTION_DELETED":
    case "SUBSCRIPTION_INACTIVATED": {
      const wasCanceled = sub.status === "canceled";
      const r = await set("canceled", { invoice_url: null });
      // cancelou pelo painel: a tela já disse; aqui só avisa quando veio de fora (pelo Asaas)
      if (!wasCanceled) {
        await tell(sub.user_id, BILLING_TEXT.canceled(sub.paid_until));
        void emitEvent("subscription.canceled", { user_id: sub.user_id, paid_until: sub.paid_until });
      }
      return r;
    }
    default:
      return { handled: false };
  }
}

/** Primeiro pagamento de quem foi convidado: quem convidou ganha desconto na próxima mensalidade (uma vez por convidado). */
export async function creditReferral(userId: string) {
  const s = await getSettings();
  const percent = Number(s.billingReferralPercent ?? 0);
  if (!(percent > 0)) return null;
  const u = await one<{ invited_by: string | null; name: string }>("SELECT invited_by, COALESCE(full_name, name, '+' || phone) AS name FROM users WHERE id = $1", [userId]);
  if (!u?.invited_by || u.invited_by === userId) return null;
  const inviter = await one("SELECT id, phone, billing_exempt FROM users WHERE id = $1 AND status = 'active'", [u.invited_by]);
  // quem não paga (dono, liberados) não tem mensalidade para descontar
  if (!inviter || isOwner(inviter.phone) || inviter.billing_exempt) return null;
  const credit = await one(
    "INSERT INTO referral_credits (user_id, from_user_id, percent) VALUES ($1, $2, $3) ON CONFLICT (from_user_id) DO NOTHING RETURNING *",
    [inviter.id, userId, percent],
  );
  if (!credit) return null;
  await tell(inviter.id, BILLING_TEXT.referral(u.name.split(" ")[0]!, percent));
  void emitEvent("referral.credited", { user_id: inviter.id, from_user_id: userId, percent });
  // já tem cobrança em aberto: aplica agora; senão entra na próxima que o Asaas criar (PAYMENT_CREATED)
  const sub = await getSubscription(inviter.id);
  if (sub?.asaas_subscription_id && sub.status !== "canceled") {
    const pending = (await asaas("GET", `/payments?subscription=${sub.asaas_subscription_id}&status=PENDING&limit=5`).catch(() => null))?.data ?? [];
    const next = pending.sort((a: any, b: any) => String(a.dueDate).localeCompare(String(b.dueDate)))[0];
    if (next) await applyReferralCredits(inviter.id, next);
  }
  return credit;
}

/** Põe UM crédito de indicação como desconto numa cobrança em aberto (um por mensalidade; o resto fica para as próximas). */
export async function applyReferralCredits(userId: string, payment: { id: string; value: number; dueDate: string; billingType?: string }) {
  if (await one("SELECT 1 FROM referral_credits WHERE applied_payment_id = $1", [payment.id])) return null;
  const credit = await one("SELECT * FROM referral_credits WHERE user_id = $1 AND applied_payment_id IS NULL ORDER BY created_at LIMIT 1", [userId]);
  if (!credit) return null;
  await asaas("POST", `/payments/${payment.id}`, {
    billingType: payment.billingType ?? "UNDEFINED",
    value: payment.value,
    dueDate: payment.dueDate,
    discount: { value: Number(credit.percent), dueDateLimitDays: 0, type: "PERCENTAGE" },
  });
  await query("UPDATE referral_credits SET applied_payment_id = $2, applied_at = now() WHERE id = $1", [credit.id, payment.id]);
  return credit;
}

/**
 * Rodada diária (worker, de manhã): lembra o vencimento de quem paga por Pix/boleto (N dias antes e no dia)
 * e avisa um dia antes de acabarem os dias grátis de quem ainda não assinou. Cartão renova sozinho: não lembra.
 */
export async function billingReminders(log?: { info: (...a: any[]) => void; error: (...a: any[]) => void }) {
  const s = await getSettings();
  if (!s.billingEnabled) return { due: 0, trial: 0 };
  const plan = planOf(s);
  const before = Number(s.billingReminderDays ?? 3);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: s.timezone || config.DEFAULT_TIMEZONE }).format(new Date());
  let due = 0;
  const subs = await many<SubscriptionRow & { days: number }>(
    `SELECT s.*, to_char(s.next_due_date, 'YYYY-MM-DD') AS next_due_date, (s.next_due_date - $1::date) AS days
       FROM subscriptions s JOIN users u ON u.id = s.user_id
      WHERE s.status IN ('trial', 'active') AND s.next_due_date IS NOT NULL AND u.status = 'active' AND NOT u.billing_exempt
        AND COALESCE(s.last_billing_type, '') <> 'CREDIT_CARD' AND s.reminded_on IS DISTINCT FROM $1::date
        AND (s.next_due_date - $1::date) IN ($2::int, 0)`,
    [today, before],
  );
  for (const sub of subs) {
    try {
      await tell(sub.user_id, BILLING_TEXT.dueSoon(Number(sub.value), Number(sub.days), sub.next_due_date!, sub.invoice_url ?? billingLink()));
      await query("UPDATE subscriptions SET reminded_on = $2 WHERE user_id = $1", [sub.user_id, today]);
      due++;
    } catch (err) {
      log?.error({ err, userId: sub.user_id }, "lembrete de mensalidade falhou");
    }
  }
  // dias grátis acabando amanhã e sem assinatura
  let trial = 0;
  const people = await many(
    `SELECT u.* FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
      WHERE u.status = 'active' AND NOT u.billing_exempt AND (s.user_id IS NULL OR s.status = 'canceled')
        AND NOT (u.profile ? 'trial_notice_at') LIMIT 500`,
  );
  for (const u of people) {
    if (isOwner(u.phone)) continue;
    const left = trialEnd(u, s).getTime() - Date.now();
    if (left <= 0 || left > DAY) continue;
    try {
      await tell(u.id, BILLING_TEXT.trialEnding(plan.name, plan.price, billingLink()));
      await query("UPDATE users SET profile = profile || jsonb_build_object('trial_notice_at', now()) WHERE id = $1", [u.id]);
      trial++;
    } catch (err) {
      log?.error({ err, userId: u.id }, "aviso de fim dos dias grátis falhou");
    }
  }
  if (due || trial) log?.info({ due, trial }, "lembretes de assinatura enviados");
  return { due, trial };
}

/** Resumo para o dono: quantos em cada situação e quem são. */
export async function billingOverview() {
  const s = await getSettings();
  const rows = await many(
    `SELECT u.id, COALESCE(u.full_name, u.name, '+' || u.phone) AS name, u.phone, u.billing_exempt, u.created_at, u.terms_accepted_at,
            s.status, s.value, s.next_due_date, s.paid_until, s.last_payment_at
       FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id WHERE u.status = 'active' ORDER BY u.created_at DESC LIMIT 500`,
  );
  const people = [];
  const counts: Record<string, number> = { trial: 0, active: 0, blocked: 0, exempt: 0 };
  for (const r of rows) {
    const a = await billingAccess(r, { ...s, billingEnabled: true });
    const state = !a.allowed ? "blocked" : a.state === "exempt" ? "exempt" : a.state === "trial" ? "trial" : "active";
    counts[state] = (counts[state] ?? 0) + 1;
    people.push({ id: r.id, name: r.name, state, detail: a.allowed ? a.state : a.state, until: a.allowed && a.until ? a.until.toISOString() : null, exempt: Boolean(r.billing_exempt), owner: isOwner(r.phone) });
  }
  const mrr = rows.filter((r) => r.status === "active").reduce((acc, r) => acc + Number(r.value ?? 0), 0);
  return { counts, mrr, people };
}
