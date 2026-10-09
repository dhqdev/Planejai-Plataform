import { config } from "./config.js";
import { GRAIN_TEXT, creditGrains, ensureWallet, grains, grainsExempt, grainsLink, packById, planById, plansOf, tellPerson } from "./credits.js";
import { emitEvent } from "./events.js";
import { many, one, query } from "./db/pool.js";
import { isOwner } from "./ingest.js";
import { getCredentials } from "./integrations/registry.js";
import { notify } from "./notifications.js";
import { type AgentSettings, type BillingPlan, getSettings } from "./settings.js";

/**
 * Cobrança por grãos pelo Asaas (o dono liga em Configurações > Cobrança e cola a chave em Integrações > Asaas).
 * - Cada pessoa começa com os grãos de boas-vindas; o assistente responde enquanto houver grão (credits.ts).
 * - Plano mensal: cada pagamento confirmado recarrega os grãos do plano. Cartão fica salvo no Asaas e renova sozinho;
 *   Pix ou boleto geram a cobrança todo mês.
 * - Acabou antes do mês virar: compra um pacote avulso (não vence) ou sobe de plano (paga a diferença e ganha a diferença de grãos na hora).
 *   Descer de plano vale a partir da próxima mensalidade.
 * - Indicação: cada amigo convidado que paga um plano dá billingReferralStep% de desconto na mensalidade de quem convidou,
 *   até billingReferralMax%. O desconto acompanha: amigo que para de pagar tira a parte dele.
 *
 * Dados de cartão nunca passam por aqui: a pessoa paga na página do Asaas. O CPF/CNPJ vai para o Asaas e não fica no nosso banco.
 * O Asaas avisa pelo webhook (/webhooks/asaas), que é quem credita os grãos.
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
  plan_id: string | null;
  next_plan_id: string | null;
  base_value: number | null;
  discount_percent: number;
  pay_method: string | null;
  card_brand: string | null;
  card_last4: string | null;
}

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

/** "produção" ou "sandbox" pela chave salva; null sem Asaas conectado. */
export async function asaasMode(): Promise<"produção" | "sandbox" | null> {
  const c = await getCredentials("asaas").catch(() => null);
  if (!c?.api_key) return null;
  return asaasBase(c.api_key).includes("sandbox") ? "sandbox" : "produção";
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

const SUB_COLS = "*, to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date, to_char(paid_until, 'YYYY-MM-DD') AS paid_until";

export async function getSubscription(userId: string) {
  // datas como texto AAAA-MM-DD: são dias de calendário, sem fuso
  return one<SubscriptionRow>(`SELECT ${SUB_COLS} FROM subscriptions WHERE user_id = $1`, [userId]);
}

/** Tem plano em andamento (assinou e não cancelou)? */
export const hasPlan = (sub: SubscriptionRow | null | undefined): sub is SubscriptionRow =>
  Boolean(sub?.asaas_subscription_id && sub.status !== "canceled");

export type Access =
  | { allowed: true; state: "off" | "exempt" | "grains"; balance?: number }
  | { allowed: false; state: "empty"; balance: 0 };

/** A pessoa pode usar o assistente agora? Regra única, usada pelo assistente e pela tela de grãos. */
export async function billingAccess(user: any, s?: AgentSettings): Promise<Access> {
  s ??= await getSettings();
  if (!s.billingEnabled) return { allowed: true, state: "off" };
  if (grainsExempt(user, s)) return { allowed: true, state: "exempt" };
  const w = await ensureWallet(user.id, s);
  if (w.total > 0) return { allowed: true, state: "grains", balance: w.total };
  return { allowed: false, state: "empty", balance: 0 };
}

export function billingLink() {
  return grainsLink();
}

/** Texto para a pessoa quando o assistente está parado por falta de grãos. */
export function blockedMessage(_a?: unknown) {
  return GRAIN_TEXT.empty(grainsLink());
}

/** Preço com o desconto de indicação, em centavos certos. */
export const withDiscount = (price: number, percent: number) => Math.round(price * (100 - percent)) / 100;

/** Quantos amigos convidados pela pessoa estão com plano pago em dia. */
export async function payingFriends(userId: string) {
  const r = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM users u JOIN subscriptions s ON s.user_id = u.id
      WHERE u.invited_by = $1 AND u.id <> $1 AND u.status = 'active' AND s.status = 'active'`,
    [userId],
  );
  return r?.n ?? 0;
}

/** Desconto por indicação da pessoa agora (%). */
export async function referralDiscount(userId: string, s?: AgentSettings) {
  s ??= await getSettings();
  const step = Number(s.billingReferralStep ?? 0);
  if (!(step > 0)) return { friends: 0, percent: 0, step: 0, max: 0 };
  const friends = await payingFriends(userId);
  const max = Number(s.billingReferralMax ?? 0);
  return { friends, percent: Math.min(max, friends * step), step, max };
}

/** Cliente no Asaas: cria uma vez (com nome e CPF/CNPJ) e guarda só o id. */
async function ensureCustomer(user: any, input?: { name?: string; cpfCnpj?: string; email?: string | null }) {
  const existing = await getSubscription(user.id);
  if (existing?.asaas_customer_id) return existing.asaas_customer_id;
  const name = String(input?.name ?? "").trim().slice(0, 100);
  if (name.split(/\s+/).length < 2) throw new Error("Informe o nome completo.");
  if (!validCpfCnpj(String(input?.cpfCnpj ?? ""))) throw new Error("CPF ou CNPJ inválido.");
  const customer = await asaas("POST", "/customers", {
    name,
    cpfCnpj: onlyDigits(input?.cpfCnpj),
    email: input?.email?.trim() || undefined,
    mobilePhone: String(user.phone).replace(/^55/, ""),
    externalReference: user.id,
    // os avisos de cobrança saem por nós (o assistente já fala com a pessoa)
    notificationDisabled: true,
  });
  // ainda sem plano: a linha guarda só o cliente (status canceled = nenhum plano em andamento)
  await query(
    `INSERT INTO subscriptions (user_id, asaas_customer_id, status, value) VALUES ($1, $2, 'canceled', 0)
     ON CONFLICT (user_id) DO UPDATE SET asaas_customer_id = $2, updated_at = now()`,
    [user.id, String(customer.id)],
  );
  return String(customer.id);
}

export type PayMethod = "card" | "pix";

/** Assina um plano. A primeira cobrança é hoje; os grãos do plano entram quando o Asaas confirmar o pagamento. */
export async function subscribe(user: any, input: { planId: string; method?: PayMethod; name?: string; cpfCnpj?: string; email?: string | null }) {
  const s = await getSettings();
  if (!s.billingEnabled) throw new Error("A cobrança ainda não está ligada.");
  const plan = planById(s, input.planId);
  if (!plan) throw new Error("Plano não encontrado.");
  const existing = await getSubscription(user.id);
  if (hasPlan(existing)) throw new Error("Você já tem um plano. Use a troca de plano.");
  const customerId = await ensureCustomer(user, input);
  const method: PayMethod = input.method === "pix" ? "pix" : "card";
  const { percent } = await referralDiscount(user.id, s);
  const value = withDiscount(plan.price, percent);
  const created = await asaas("POST", "/subscriptions", {
    customer: customerId,
    // cartão: a pessoa paga a primeira na página do Asaas e as próximas saem sozinhas no mesmo cartão
    billingType: method === "card" ? "CREDIT_CARD" : "UNDEFINED",
    value,
    nextDueDate: isoDay(new Date()),
    cycle: "MONTHLY",
    description: `Planejai ${plan.name} (${grains(plan.grains)} por mês)`,
    externalReference: user.id,
  });
  const first = (await asaas("GET", `/subscriptions/${created.id}/payments`).catch(() => null))?.data?.[0];
  const row = await one<SubscriptionRow>(
    `UPDATE subscriptions SET asaas_subscription_id = $2, status = 'trial', value = $3, base_value = $4, discount_percent = $5, plan_id = $6,
            next_plan_id = NULL, pay_method = $7, next_due_date = $8, invoice_url = $9, paid_until = NULL, updated_at = now()
      WHERE user_id = $1 RETURNING ${SUB_COLS}`,
    [user.id, String(created.id), value, plan.price, percent, plan.id, method, isoDay(new Date()), first?.invoiceUrl ?? null],
  );
  await notify({ userId: null, kind: "assinatura", title: `${user.full_name ?? user.name ?? "+" + user.phone} assinou o plano ${plan.name}`, link: "/settings" });
  return row!;
}

/** Cancela no Asaas. Os grãos que já estão na carteira continuam valendo até acabar. */
export async function cancelSubscription(userId: string) {
  const sub = await getSubscription(userId);
  if (!hasPlan(sub)) throw new Error("Não há plano para cancelar.");
  await asaas("DELETE", `/subscriptions/${sub.asaas_subscription_id}`).catch((e: Error) => {
    // já não existe do lado do Asaas: segue e marca como cancelada aqui
    if (!/404|não encontrad|not found/i.test(e.message)) throw e;
  });
  await query("UPDATE subscriptions SET status = 'canceled', invoice_url = NULL, next_plan_id = NULL, updated_at = now() WHERE user_id = $1", [userId]);
  await syncInviterDiscount(userId).catch(() => {});
}

/** Muda o valor da assinatura no Asaas (e da cobrança que já está em aberto). */
async function setSubscriptionValue(sub: SubscriptionRow, value: number, description?: string) {
  await asaas("POST", `/subscriptions/${sub.asaas_subscription_id}`, { value, updatePendingPayments: true, ...(description ? { description } : {}) });
}

/**
 * Troca de plano.
 * - Subir: paga hoje a diferença do mês (com o desconto de indicação) e, quando cair, ganha a diferença de grãos na hora;
 *   a mensalidade passa a ser a do plano novo.
 * - Descer: vale a partir da próxima mensalidade (os grãos deste mês ficam).
 * - Ainda sem nenhum pagamento: só troca o plano da primeira cobrança.
 */
export async function changePlan(user: any, planId: string): Promise<{ kind: "upgrade" | "downgrade" | "switched"; invoiceUrl?: string | null; plan: BillingPlan }> {
  const s = await getSettings();
  const sub = await getSubscription(user.id);
  if (!hasPlan(sub)) throw new Error("Você ainda não tem plano. Escolha um para assinar.");
  const now = planById(s, sub.plan_id);
  const next = planById(s, planId);
  if (!next) throw new Error("Plano não encontrado.");
  if (now?.id === next.id && !sub.next_plan_id) throw new Error("Você já está nesse plano.");
  const percent = Number(sub.discount_percent ?? 0);
  const desc = `Planejai ${next.name} (${grains(next.grains)} por mês)`;
  if (!sub.last_payment_at || !now) {
    await setSubscriptionValue(sub, withDiscount(next.price, percent), desc);
    await query("UPDATE subscriptions SET plan_id = $2, base_value = $3, value = $4, next_plan_id = NULL, updated_at = now() WHERE user_id = $1", [user.id, next.id, next.price, withDiscount(next.price, percent)]);
    return { kind: "switched", plan: next };
  }
  if (next.id === now.id) {
    // desistiu de descer: volta o valor do plano atual
    await setSubscriptionValue(sub, withDiscount(now.price, percent));
    await query("UPDATE subscriptions SET next_plan_id = NULL, value = $2, updated_at = now() WHERE user_id = $1", [user.id, withDiscount(now.price, percent)]);
    return { kind: "switched", plan: now };
  }
  if (next.price < now.price) {
    await setSubscriptionValue(sub, withDiscount(next.price, percent), desc);
    await query("UPDATE subscriptions SET next_plan_id = $2, value = $3, updated_at = now() WHERE user_id = $1", [user.id, next.id, withDiscount(next.price, percent)]);
    return { kind: "downgrade", plan: next };
  }
  const value = Math.max(1, withDiscount(next.price - now.price, percent));
  const extra = Math.max(0, next.grains - now.grains);
  const purchase = await createCharge(user, sub.asaas_customer_id, {
    kind: "upgrade",
    itemId: next.id,
    grains: extra,
    value,
    description: `Planejai: troca do ${now.name} para o ${next.name} (+${grains(extra)})`,
  });
  return { kind: "upgrade", invoiceUrl: purchase.invoice_url, plan: next };
}

/** Cobrança avulsa no Asaas (pacote ou diferença de plano). Pix, cartão ou boleto na página do Asaas. */
async function createCharge(user: any, customerId: string, item: { kind: "pack" | "upgrade"; itemId: string; grains: number; value: number; description: string }) {
  // a mesma compra pedida duas vezes seguidas reaproveita a cobrança em aberto
  const open = await one(
    "SELECT * FROM grain_purchases WHERE user_id = $1 AND kind = $2 AND item_id = $3 AND status = 'pending' AND created_at > now() - interval '1 day' AND invoice_url IS NOT NULL",
    [user.id, item.kind, item.itemId],
  );
  if (open) return open;
  const row = await one("INSERT INTO grain_purchases (user_id, kind, item_id, grains, value) VALUES ($1, $2, $3, $4, $5) RETURNING *", [user.id, item.kind, item.itemId, item.grains, item.value]);
  const tomorrow = new Date(Date.now() + 86_400_000);
  const payment = await asaas("POST", "/payments", {
    customer: customerId,
    billingType: "UNDEFINED",
    value: item.value,
    dueDate: isoDay(tomorrow),
    description: item.description,
    externalReference: `grains:${row.id}`,
  });
  return one("UPDATE grain_purchases SET asaas_payment_id = $2, invoice_url = $3 WHERE id = $1 RETURNING *", [row.id, String(payment.id), payment.invoiceUrl ?? null]);
}

/** Compra um pacote avulso de grãos. Sem cadastro no Asaas ainda, precisa de nome e CPF/CNPJ. */
export async function buyPack(user: any, packId: string, input?: { name?: string; cpfCnpj?: string; email?: string | null }) {
  const s = await getSettings();
  if (!s.billingEnabled) throw new Error("A cobrança ainda não está ligada.");
  const pack = packById(s, packId);
  if (!pack) throw new Error("Pacote não encontrado.");
  const customerId = await ensureCustomer(user, input);
  return createCharge(user, customerId, { kind: "pack", itemId: pack.id, grains: pack.grains, value: pack.price, description: `Planejai: pacote de ${grains(pack.grains)}` });
}

/** Mesmo dia no mês seguinte; sem esse dia lá (31/01, 29/02), cai no último dia do mês (28/02, não 03/03). */
export const addMonth = (isoDate: string) => {
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return isoDay(new Date(Date.UTC(y, m, Math.min(d, last), 12)));
};

const brl = (n: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n).replace(/\u00a0/g, " ");
const ddmm = (iso?: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "");

/** Mensagens que cada evento do Asaas manda para a pessoa (sem IA: texto fixo, zero token). */
export const BILLING_TEXT = {
  firstPayment: (plan: string, amount: number, next: string) =>
    `Pagamento confirmado, obrigado por assinar o ${plan}! Já coloquei ${grains(amount)} na sua conta. A próxima mensalidade vence dia ${ddmm(next)}.`,
  renewed: (amount: number, next: string) => `Recebi a mensalidade, obrigado! Seus grãos do plano foram recarregados: ${grains(amount)}. A próxima vence dia ${ddmm(next)}.`,
  pack: (amount: number, total: number) => `Pagamento confirmado! Entraram ${grains(amount)} e agora você tem ${grains(total)}. Pode mandar o que precisar.`,
  upgrade: (plan: string, amount: number) => `Pronto, agora você está no ${plan}! Já entraram ${grains(amount)} a mais neste mês.`,
  overdue: (value: number, link: string) => `A mensalidade de ${brl(value)} venceu e ainda não apareceu aqui, então os grãos do plano não foram recarregados. Dá para pagar por Pix, cartão ou boleto: ${link}`,
  dueSoon: (value: number, days: number, due: string, link: string) =>
    `${days === 0 ? "Hoje vence" : days === 1 ? "Amanhã vence" : `Dia ${ddmm(due)} vence`} a sua mensalidade de ${brl(value)}. Se quiser já deixar pago: ${link}`,
  canceled: () => "Seu plano foi cancelado. Os grãos que já estão na sua conta continuam valendo até acabar, e dá para voltar quando quiser.",
  referral: (name: string, percent: number, friends: number) =>
    `${name} assinou pelo seu convite! Agora são ${friends} ${friends === 1 ? "amigo" : "amigos"} pagando, e sua mensalidade tem ${percent}% de desconto. Obrigado por indicar!`,
};

/** Evento já tratado? O Asaas reenvia quando não recebe 200; cada evento só vira mensagem uma vez. Sem id nenhum, não dá para saber. */
function eventKey(body: any) {
  if (body?.id) return String(body.id);
  const p = body?.payment ?? {};
  return p.id ? `${body?.event}:${p.id}:${p.status ?? ""}` : null;
}

/**
 * Evento do Asaas. Mexe só no que criamos: assinatura de plano (pelo id da assinatura) ou compra de grãos
 * (externalReference grains:<id>). Pagamento confirmado credita os grãos; vencido avisa; assinatura apagada vira cancelada.
 * Cada mudança avisa a pessoa no WhatsApp e no sininho do painel e vira evento para o n8n.
 */
export async function handleAsaasEvent(body: any): Promise<{ handled: boolean; status?: string; duplicate?: boolean }> {
  const event = String(body?.event ?? "");
  const p = body?.payment ?? {};
  const ref = String(p.externalReference ?? "");
  const subId = p.subscription ?? body?.subscription?.id;
  const purchase = !subId && ref.startsWith("grains:") ? await one("SELECT * FROM grain_purchases WHERE id::text = $1", [ref.slice(7)]) : null;
  const sub = subId ? await one<SubscriptionRow>(`SELECT ${SUB_COLS} FROM subscriptions WHERE asaas_subscription_id = $1`, [String(subId)]) : null;
  if (!sub && !purchase) return { handled: false };
  const key = eventKey(body);
  if (key && (await one("SELECT 1 FROM asaas_events WHERE id = $1", [key]))) return { handled: true, duplicate: true, status: sub?.status ?? purchase?.status };
  const r = purchase ? await applyPurchaseEvent(event, p, purchase) : await applyAsaasEvent(event, body, sub!);
  // marca só depois de dar certo: se falhar, o 500 faz o Asaas mandar de novo
  if (key) await query("INSERT INTO asaas_events (id, event) VALUES ($1, $2) ON CONFLICT DO NOTHING", [key, event]);
  return r;
}

const PAID = new Set(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_RECEIVED_IN_CASH"]);

/** Compra avulsa: pagou entra (uma vez); apagada ou vencida só fecha a compra. */
async function applyPurchaseEvent(event: string, p: any, purchase: any) {
  if (PAID.has(event)) {
    const paid = await one("UPDATE grain_purchases SET status = 'paid', paid_at = now() WHERE id = $1 AND status <> 'paid' RETURNING *", [purchase.id]);
    if (!paid) return { handled: true, status: "paid" };
    const s = await getSettings();
    if (paid.kind === "upgrade") {
      const sub = await getSubscription(paid.user_id);
      const plan = planById(s, paid.item_id);
      if (sub && plan) {
        const percent = Number(sub.discount_percent ?? 0);
        if (hasPlan(sub)) await setSubscriptionValue(sub, withDiscount(plan.price, percent), `Planejai ${plan.name} (${grains(plan.grains)} por mês)`).catch((err) => console.error("[troca de plano]", err));
        await query("UPDATE subscriptions SET plan_id = $2, base_value = $3, value = $4, next_plan_id = NULL, updated_at = now() WHERE user_id = $1", [paid.user_id, plan.id, plan.price, withDiscount(plan.price, percent)]);
      }
      await creditGrains(paid.user_id, { amount: paid.grains, bucket: "plan", reason: "troca", ref: paid.id, note: plan?.name });
      await tellPerson(paid.user_id, BILLING_TEXT.upgrade(plan?.name ?? "plano novo", paid.grains));
    } else {
      const w = await creditGrains(paid.user_id, { amount: paid.grains, bucket: "extra", reason: "pacote", ref: paid.id, note: grains(paid.grains) });
      if (w) await tellPerson(paid.user_id, BILLING_TEXT.pack(paid.grains, w.total));
    }
    await notify({ userId: null, kind: "assinatura", title: `Compra de grãos: ${brl(Number(paid.value))}`, body: `${paid.kind === "upgrade" ? "Troca de plano" : "Pacote"} de ${grains(paid.grains)}.`, link: "/settings" });
    void emitEvent("payment.confirmed", { user_id: paid.user_id, value: Number(paid.value), billing_type: p.billingType ?? null, kind: paid.kind, grains: paid.grains, payment_id: p.id ?? null });
    return { handled: true, status: "paid" };
  }
  if (event === "PAYMENT_OVERDUE" || event === "PAYMENT_DELETED") {
    await query("UPDATE grain_purchases SET status = 'canceled' WHERE id = $1 AND status = 'pending'", [purchase.id]);
    return { handled: true, status: "canceled" };
  }
  if (event === "PAYMENT_REFUNDED" || event === "PAYMENT_CHARGEBACK_REQUESTED") {
    await query("UPDATE grain_purchases SET status = 'refunded' WHERE id = $1", [purchase.id]);
    await notify({ userId: null, kind: "assinatura", title: event === "PAYMENT_REFUNDED" ? "Compra de grãos estornada" : "Contestação no cartão", body: `${brl(Number(purchase.value))} (${grains(purchase.grains)}). Os grãos já usados não voltam; ajuste em Configurações se precisar.`, link: "/settings" });
    return { handled: true, status: "refunded" };
  }
  return { handled: true, status: purchase.status };
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
  if (PAID.has(event)) {
    const due = String(p.dueDate ?? isoDay(new Date())).slice(0, 10);
    const next = addMonth(due);
    const ref = String(p.id ?? `${sub.asaas_subscription_id}:${due}`);
    // cartão manda CONFIRMED e depois RECEIVED do mesmo pagamento (o RECEIVED pode vir ~30 dias depois, com o mês seguinte
    // já em atraso): pagamento já creditado não mexe em nada, senão voltaria para "em dia" e apagaria o link da cobrança nova
    if (await one("SELECT 1 FROM grain_ledger WHERE user_id = $1 AND reason = 'plano' AND ref = $2", [sub.user_id, ref])) return { handled: true, status: sub.status };
    // mensalidade de um mês anterior paga depois de uma mais nova: o mês dela já passou e o plano não acumula
    if (sub.paid_until && next < sub.paid_until) {
      await notify({ userId: null, kind: "assinatura", title: "Mensalidade antiga paga", body: `${brl(value)}, vencimento ${ddmm(due)}. O plano já está pago até ${ddmm(sub.paid_until)}; nada mudou.`, link: "/settings" });
      return { handled: true, status: sub.status };
    }
    const first = !sub.last_payment_at;
    const wasBlocked = sub.status === "overdue";
    const today = isoDay(new Date());
    // pagou um mês atrasado e o seguinte também já venceu: continua pendente (o link da cobrança seguinte fica)
    const status: SubStatus = wasBlocked && next < today ? "overdue" : "active";
    const s = await getSettings();
    // descer de plano vale a partir desta mensalidade
    const planId = sub.next_plan_id ?? sub.plan_id;
    const plan = planById(s, planId);
    const card = p.creditCard ?? {};
    // o link guardado pode já ser o da cobrança seguinte (PAYMENT_CREATED chegou antes): só apaga o desta
    const ownLink = !sub.invoice_url || !p.invoiceUrl || p.invoiceUrl === sub.invoice_url;
    const r = await set(status, {
      paid_until: next,
      next_due_date: next,
      last_payment_at: new Date().toISOString(),
      ...(ownLink ? { invoice_url: null } : {}),
      last_billing_type: p.billingType ?? null,
      plan_id: planId,
      next_plan_id: null,
      ...(plan ? { base_value: plan.price } : {}),
      ...(card.creditCardNumber ? { card_brand: String(card.creditCardBrand ?? "").slice(0, 20) || null, card_last4: String(card.creditCardNumber).slice(-4) } : {}),
    });
    if (wasBlocked) await query("UPDATE users SET profile = profile - 'billing_notice_at' WHERE id = $1", [sub.user_id]);
    // o crédito tem ref do pagamento e entra uma vez só (dois eventos ao mesmo tempo: o segundo para aqui)
    const credited = plan ? await creditGrains(sub.user_id, { amount: plan.grains, bucket: "plan", reason: "plano", ref, note: plan.name, set: true }) : null;
    if (!credited) return r;
    await tellPerson(sub.user_id, first ? BILLING_TEXT.firstPayment(plan!.name, plan!.grains, next) : BILLING_TEXT.renewed(plan!.grains, next));
    void emitEvent("payment.confirmed", { user_id: sub.user_id, value, billing_type: p.billingType ?? null, first, next_due_date: next, payment_id: p.id ?? null, plan: plan!.id });
    // amigo que passou a pagar: quem convidou ganha mais desconto
    if (first) await syncInviterDiscount(sub.user_id, true).catch((err) => console.error("[indicação]", err));
    return r;
  }
  switch (event) {
    case "PAYMENT_CREATED":
    case "PAYMENT_UPDATED":
    case "PAYMENT_RESTORED":
      // a próxima cobrança do mês: guarda o link para a pessoa pagar
      if (p.status === "PENDING" || p.status === "OVERDUE") {
        await query("UPDATE subscriptions SET invoice_url = $2, next_due_date = COALESCE($3, next_due_date), updated_at = now() WHERE user_id = $1", [sub.user_id, p.invoiceUrl ?? null, p.dueDate ?? null]);
      }
      return { handled: true, status: sub.status };
    case "PAYMENT_OVERDUE": {
      const link = p.invoiceUrl ?? sub.invoice_url ?? billingLink();
      const r = await set("overdue", { invoice_url: link });
      await tellPerson(sub.user_id, BILLING_TEXT.overdue(value, link));
      void emitEvent("payment.overdue", { user_id: sub.user_id, value, invoice_url: link, due_date: p.dueDate ?? null });
      await syncInviterDiscount(sub.user_id).catch(() => {});
      return r;
    }
    case "PAYMENT_DELETED":
      // cobrança apagada no Asaas: o link dela não serve mais
      if (p.invoiceUrl && p.invoiceUrl === sub.invoice_url) await query("UPDATE subscriptions SET invoice_url = NULL, updated_at = now() WHERE user_id = $1", [sub.user_id]);
      await notify({ userId: null, kind: "assinatura", title: "Cobrança apagada no Asaas", body: `${brl(value)}${p.dueDate ? `, vencimento ${ddmm(p.dueDate)}` : ""}.`, link: "/settings" });
      return { handled: true, status: sub.status };
    case "PAYMENT_REFUND_REQUESTED":
      await notify({ userId: null, kind: "assinatura", title: "Pedido de estorno", body: `${brl(value)}. Se o estorno sair, o plano fica pendente até pagar de novo.`, link: "/settings" });
      return { handled: true, status: sub.status };
    case "PAYMENT_REFUNDED":
    case "PAYMENT_CHARGEBACK_REQUESTED": {
      const r = await set("overdue", { paid_until: null });
      await notify({ userId: null, kind: "assinatura", title: event === "PAYMENT_REFUNDED" ? "Mensalidade estornada" : "Contestação no cartão", body: `${brl(value)}. O plano fica pendente até pagar de novo.`, link: "/settings" });
      await syncInviterDiscount(sub.user_id).catch(() => {});
      return r;
    }
    case "SUBSCRIPTION_DELETED":
    case "SUBSCRIPTION_INACTIVATED": {
      const wasCanceled = sub.status === "canceled";
      const r = await set("canceled", { invoice_url: null, next_plan_id: null });
      // cancelou pelo painel: a tela já disse; aqui só avisa quando veio de fora (pelo Asaas)
      if (!wasCanceled) {
        await tellPerson(sub.user_id, BILLING_TEXT.canceled());
        void emitEvent("subscription.canceled", { user_id: sub.user_id, paid_until: sub.paid_until });
        await syncInviterDiscount(sub.user_id).catch(() => {});
      }
      return r;
    }
    default:
      return { handled: false };
  }
}

/**
 * Recalcula o desconto de indicação de alguém e aplica na assinatura dele no Asaas (inclusive na cobrança em aberto).
 * `fromFriendId` = um convidado mudou de situação: recalcula para quem convidou.
 */
export async function syncInviterDiscount(fromFriendId: string, celebrate = false) {
  const u = await one<{ invited_by: string | null; name: string }>("SELECT invited_by, COALESCE(full_name, name, '+' || phone) AS name FROM users WHERE id = $1", [fromFriendId]);
  if (!u?.invited_by || u.invited_by === fromFriendId) return null;
  const r = await syncDiscount(u.invited_by);
  if (celebrate && r && r.percent > r.before) await tellPerson(u.invited_by, BILLING_TEXT.referral(u.name.split(" ")[0]!, r.percent, r.friends));
  if (r && r.percent !== r.before) void emitEvent("referral.credited", { user_id: u.invited_by, from_user_id: fromFriendId, percent: r.percent, friends: r.friends });
  return r;
}

export async function syncDiscount(userId: string) {
  const s = await getSettings();
  const sub = await getSubscription(userId);
  const { friends, percent } = await referralDiscount(userId, s);
  const before = Number(sub?.discount_percent ?? 0);
  if (!hasPlan(sub)) return { friends, percent, before };
  const owner = await one("SELECT phone, billing_exempt FROM users WHERE id = $1", [userId]);
  if (!owner || isOwner(owner.phone) || owner.billing_exempt) return { friends, percent, before };
  const plan = planById(s, sub.next_plan_id ?? sub.plan_id);
  const base = plan?.price ?? Number(sub.base_value ?? sub.value);
  const value = withDiscount(base, percent);
  if (percent !== before || Math.abs(value - Number(sub.value)) >= 0.01) {
    await setSubscriptionValue(sub, value);
    await query("UPDATE subscriptions SET discount_percent = $2, value = $3, updated_at = now() WHERE user_id = $1", [userId, percent, value]);
  }
  return { friends, percent, before };
}

/**
 * Rodada diária (de manhã): lembra o vencimento de quem paga plano por Pix/boleto (N dias antes e no dia)
 * e confere o desconto de indicação de quem tem plano. Cartão renova sozinho: não lembra.
 */
export async function billingReminders(log?: { info: (...a: any[]) => void; error: (...a: any[]) => void }) {
  const s = await getSettings();
  if (!s.billingEnabled) return { due: 0, discounts: 0 };
  const before = Number(s.billingReminderDays ?? 3);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: s.timezone || config.DEFAULT_TIMEZONE }).format(new Date());
  let due = 0;
  const subs = await many<SubscriptionRow & { days: number }>(
    `SELECT s.*, to_char(s.next_due_date, 'YYYY-MM-DD') AS next_due_date, (s.next_due_date - $1::date) AS days
       FROM subscriptions s JOIN users u ON u.id = s.user_id
      WHERE s.status IN ('trial', 'active') AND s.asaas_subscription_id IS NOT NULL AND s.next_due_date IS NOT NULL AND u.status = 'active' AND NOT u.billing_exempt
        AND COALESCE(s.last_billing_type, '') <> 'CREDIT_CARD' AND COALESCE(s.pay_method, '') <> 'card' AND s.reminded_on IS DISTINCT FROM $1::date
        AND (s.next_due_date - $1::date) IN ($2::int, 0)`,
    [today, before],
  );
  for (const sub of subs) {
    try {
      await tellPerson(sub.user_id, BILLING_TEXT.dueSoon(Number(sub.value), Number(sub.days), sub.next_due_date!, sub.invoice_url ?? billingLink()));
      await query("UPDATE subscriptions SET reminded_on = $2 WHERE user_id = $1", [sub.user_id, today]);
      due++;
    } catch (err) {
      log?.error({ err, userId: sub.user_id }, "lembrete de mensalidade falhou");
    }
  }
  // desconto de indicação: amigo que parou de pagar sem o webhook avisar (ou regra mudada pelo dono)
  let discounts = 0;
  const withFriends = await many<{ user_id: string }>(
    `SELECT DISTINCT s.user_id FROM subscriptions s JOIN users f ON f.invited_by = s.user_id
      WHERE s.asaas_subscription_id IS NOT NULL AND s.status <> 'canceled' LIMIT 500`,
  );
  for (const { user_id } of withFriends) {
    try {
      const r = await syncDiscount(user_id);
      if (r.percent !== r.before) discounts++;
    } catch (err) {
      log?.error({ err, userId: user_id }, "desconto de indicação falhou");
    }
  }
  if (due || discounts) log?.info({ due, discounts }, "rodada de cobrança");
  return { due, discounts };
}

/** Resumo para o dono: quem tem plano, quem está só nos grãos de boas-vindas ou avulsos, quem zerou. */
export async function billingOverview() {
  const s = await getSettings();
  const rows = await many(
    `SELECT u.id, COALESCE(u.full_name, u.name, '+' || u.phone) AS name, u.phone, u.billing_exempt,
            s.status, s.value, s.plan_id, s.asaas_subscription_id, s.discount_percent,
            COALESCE(w.plan_grains, 0) + COALESCE(w.extra_grains, 0) AS balance, w.user_id IS NOT NULL AS has_wallet
       FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id LEFT JOIN wallets w ON w.user_id = u.id
      WHERE u.status = 'active' ORDER BY u.created_at DESC LIMIT 500`,
  );
  const counts: Record<string, number> = { plan: 0, free: 0, empty: 0, exempt: 0 };
  const people = rows.map((r) => {
    const owner = isOwner(r.phone);
    const plan = r.asaas_subscription_id && r.status !== "canceled" ? planById(s, r.plan_id) : null;
    const balance = r.has_wallet ? Number(r.balance) : Number(s.billingWelcomeGrains ?? 0);
    const state = owner || r.billing_exempt ? "exempt" : plan && r.status === "active" ? "plan" : balance > 0 ? "free" : "empty";
    counts[state] = (counts[state] ?? 0) + 1;
    return { id: r.id, name: r.name, state, plan: plan?.name ?? null, status: r.status ?? null, balance, discount: Number(r.discount_percent ?? 0), exempt: Boolean(r.billing_exempt), owner };
  });
  const mrr = rows.filter((r) => r.status === "active" && r.asaas_subscription_id).reduce((acc, r) => acc + Number(r.value ?? 0), 0);
  const packs = await one<{ v: number }>("SELECT COALESCE(SUM(value), 0)::float AS v FROM grain_purchases WHERE status = 'paid' AND paid_at > date_trunc('month', now())");
  return { counts, mrr, packsMonth: packs?.v ?? 0, people };
}

/** Vitrine pública (landing e tela de grãos): planos, pacotes e as regras em números. */
export function pricingOf(s: AgentSettings) {
  return {
    enabled: Boolean(s.billingEnabled),
    plans: plansOf(s),
    packs: s.billingPacks ?? [],
    welcome: Number(s.billingWelcomeGrains ?? 0),
    grainsPerUsd: Number(s.billingGrainsPerUsd ?? 1000),
    referral: { step: Number(s.billingReferralStep ?? 0), max: Number(s.billingReferralMax ?? 0) },
  };
}
