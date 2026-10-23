import { type CardCharge, PAID, PAYMENT_STATUS, asaas, handleAsaasEvent, validCpfCnpj } from "./billing.js";
import { grains, planById, packById } from "./credits.js";
import { one } from "./db/pool.js";
import { paymentIdOf } from "./paylink.js";
import { getSettings, perksOf } from "./settings.js";

/**
 * Nosso checkout (/pagar/<token>): mostra uma cobrança do Asaas e deixa pagar por Pix (QR e copia e cola), cartão ou
 * boleto sem sair do Planejai. O token é assinado (paylink.ts), então abre sem login, como o link que ia para o Asaas.
 * Só cobrança nossa abre: pacote/troca (externalReference grains:<id>) ou mensalidade de uma assinatura da tabela.
 * Quem credita os grãos continua sendo handleAsaasEvent: o webhook ou a conferência daqui, o que chegar primeiro.
 */

export class CheckoutError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");

/** A cobrança e de quem ela é. Cobrança que não é nossa (ou token que não confere) é "não encontrada". */
async function load(token: string) {
  const id = paymentIdOf(token);
  if (!id) throw new CheckoutError("Não achei essa cobrança.", 404);
  const p = await asaas("GET", `/payments/${encodeURIComponent(id)}`).catch(() => null);
  if (!p?.id || p.deleted) throw new CheckoutError("Não achei essa cobrança. Ela pode ter sido cancelada.", 404);
  const ref = String(p.externalReference ?? "");
  const purchase = !p.subscription && ref.startsWith("grains:") ? await one("SELECT * FROM grain_purchases WHERE id::text = $1", [ref.slice(7)]) : null;
  const sub = p.subscription ? await one("SELECT * FROM subscriptions WHERE asaas_subscription_id = $1", [String(p.subscription)]) : null;
  const userId: string | undefined = purchase?.user_id ?? sub?.user_id;
  if (!userId) throw new CheckoutError("Não achei essa cobrança.", 404);
  return { p, purchase, sub, userId };
}

const isPaid = (p: any) => PAID.has(`PAYMENT_${String(p?.status ?? "")}`);

/** Pagou (pelo Asaas, agora): credita já, sem esperar o webhook. Repetir não credita duas vezes. */
async function settle(p: any) {
  if (!isPaid(p)) return false;
  await handleAsaasEvent({ event: `PAYMENT_${p.status}`, payment: p });
  return true;
}

/** O que a tela do checkout mostra: o que está sendo pago, valor, vencimento e situação. */
export async function checkoutView(token: string) {
  const { p, purchase, sub, userId } = await load(token);
  const s = await getSettings();
  const user = await one("SELECT u.full_name, u.name, COALESCE(u.email, a.email) AS email FROM users u LEFT JOIN accounts a ON a.user_id = u.id WHERE u.id = $1 LIMIT 1", [userId]);
  const status = String(p.status ?? "");
  let item: { kind: "plan" | "pack" | "upgrade"; title: string; grains: number; recurring: boolean; autoRenew: boolean; perks: string[] };
  if (purchase) {
    const plan = purchase.kind === "upgrade" ? planById(s, purchase.item_id) : null;
    item = {
      kind: purchase.kind === "upgrade" ? "upgrade" : "pack",
      title: plan ? `Troca para o ${plan.name}` : `Pacote de ${grains(Number(purchase.grains))}`,
      grains: Number(purchase.grains),
      recurring: false,
      autoRenew: false,
      perks: plan ? [`Diferença deste mês, com ${grains(Number(purchase.grains))} a mais agora`, `Depois, a mensalidade do ${plan.name}`] : ["Entram na hora em que o pagamento cai", "Não vencem"],
    };
  } else {
    const plan = planById(s, sub.next_plan_id ?? sub.plan_id);
    item = {
      kind: "plan",
      title: plan ? `Plano ${plan.name}` : "Mensalidade do Planejai",
      grains: plan?.grains ?? 0,
      recurring: true,
      autoRenew: sub.pay_method === "card",
      perks: plan ? [`${grains(plan.grains)} por mês`, ...perksOf(plan).slice(0, 3)] : [],
    };
  }
  return {
    ...item,
    value: Number(p.value ?? 0),
    dueDate: p.dueDate ? String(p.dueDate).slice(0, 10) : null,
    status: PAYMENT_STATUS[status] ?? status,
    paid: isPaid(p) ? await settle(p).then(() => true) : false,
    open: status === "PENDING" || status === "OVERDUE",
    overdue: status === "OVERDUE",
    analysis: status === "AWAITING_RISK_ANALYSIS",
    method: p.billingType ?? null,
    firstName: String(user?.full_name ?? user?.name ?? "").split(/\s+/)[0] || null,
    needsEmail: !user?.email,
    description: String(p.description ?? "").slice(0, 140),
  };
}

/** Conferência rápida enquanto a tela espera o Pix ou o boleto cair. */
export async function checkoutStatus(token: string) {
  const { p } = await load(token);
  const status = String(p.status ?? "");
  return { paid: await settle(p), open: status === "PENDING" || status === "OVERDUE", status: PAYMENT_STATUS[status] ?? status };
}

/** QR Code do Pix e o copia e cola. */
export async function checkoutPix(token: string) {
  const { p } = await load(token);
  if (await settle(p)) return { paid: true as const };
  const q = await asaas("GET", `/payments/${p.id}/pixQrCode`).catch((err: Error) => {
    throw new CheckoutError(/chave|pix/i.test(err.message) ? "O Pix não está disponível agora. Tente cartão ou boleto." : err.message);
  });
  if (!q?.payload) throw new CheckoutError("O Pix não está disponível agora. Tente cartão ou boleto.");
  return { paid: false as const, image: q.encodedImage ? `data:image/png;base64,${q.encodedImage}` : null, code: String(q.payload), expiresAt: q.expirationDate ?? null };
}

/** Linha digitável e PDF do boleto. Cobrança "Pix, cartão ou boleto" vira boleto aqui; vencida ganha vencimento amanhã. */
export async function checkoutBoleto(token: string) {
  let { p } = await load(token);
  if (await settle(p)) return { paid: true as const };
  const today = isoDay(new Date());
  if (p.billingType !== "BOLETO" || String(p.dueDate ?? "") < today) {
    const due = String(p.dueDate ?? "") < today ? isoDay(new Date(Date.now() + 86_400_000)) : undefined;
    p = await asaas("POST", `/payments/${p.id}`, { billingType: "BOLETO", value: Number(p.value), dueDate: due ?? p.dueDate });
  }
  const f = await asaas("GET", `/payments/${p.id}/identificationField`);
  const pdf = /^https:\/\/([a-z0-9-]+\.)*asaas\.com\//i.test(String(p.bankSlipUrl ?? "")) ? String(p.bankSlipUrl) : null;
  return { paid: false as const, line: String(f?.identificationField ?? ""), pdf, dueDate: p.dueDate ? String(p.dueDate).slice(0, 10) : null };
}

/** Número com o dígito verificador certo (Luhn): erro de digitação para aqui, antes de ir ao Asaas. */
export function luhn(n: string) {
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return n.length >= 13 && n.length <= 19 && sum % 10 === 0;
}

export interface CardInput {
  number?: string;
  holderName?: string;
  expiry?: string;
  ccv?: string;
  cpfCnpj?: string;
  postalCode?: string;
  addressNumber?: string;
  email?: string;
}

/** Confere o cartão digitado e monta o pedido para o Asaas. Mensagem clara para cada campo errado. */
export function cardCharge(raw: CardInput, who: { email?: string | null; phone?: string | null }, remoteIp: string): CardCharge {
  const number = digits(raw.number);
  if (!luhn(number)) throw new CheckoutError("Confira o número do cartão.");
  const holderName = String(raw.holderName ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (holderName.length < 3) throw new CheckoutError("Escreva o nome como está no cartão.");
  const [mm, yy] = String(raw.expiry ?? "").split("/").map((x) => digits(x));
  const month = Number(mm);
  const year = yy?.length === 2 ? 2000 + Number(yy) : Number(yy);
  const now = new Date();
  if (!(month >= 1 && month <= 12) || !(year >= now.getFullYear() && year <= now.getFullYear() + 20) || (year === now.getFullYear() && month < now.getMonth() + 1)) {
    throw new CheckoutError("Confira a validade do cartão (MM/AA).");
  }
  const ccv = digits(raw.ccv);
  if (ccv.length < 3 || ccv.length > 4) throw new CheckoutError("Confira o código de segurança (CVV).");
  if (!validCpfCnpj(String(raw.cpfCnpj ?? ""))) throw new CheckoutError("CPF ou CNPJ do titular inválido.");
  const postalCode = digits(raw.postalCode);
  if (postalCode.length !== 8) throw new CheckoutError("Confira o CEP do titular.");
  const addressNumber = String(raw.addressNumber ?? "").trim().slice(0, 10);
  if (!addressNumber) throw new CheckoutError("Informe o número do endereço do titular.");
  const email = String(raw.email ?? "").trim() || String(who.email ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CheckoutError("Informe um e-mail válido.");
  const phone = digits(who.phone).replace(/^55(?=\d{10,11}$)/, "");
  return {
    creditCard: { holderName, number, expiryMonth: String(month).padStart(2, "0"), expiryYear: String(year), ccv },
    creditCardHolderInfo: { name: holderName, email, cpfCnpj: digits(raw.cpfCnpj), postalCode, addressNumber, ...(phone.length >= 10 ? { mobilePhone: phone } : {}) },
    remoteIp,
  };
}

/** Quem paga: e-mail e telefone que vão junto com o cartão. */
export async function payerOf(userId: string) {
  return one<{ email: string | null; phone: string | null }>(
    "SELECT COALESCE(u.email, a.email) AS email, u.phone FROM users u LEFT JOIN accounts a ON a.user_id = u.id WHERE u.id = $1 LIMIT 1",
    [userId],
  );
}

/** Paga a cobrança no cartão digitado. Passou: credita na hora. Os dados do cartão não ficam em lugar nenhum. */
export async function checkoutCard(token: string, raw: CardInput, remoteIp: string) {
  const { p, userId } = await load(token);
  if (await settle(p)) return { paid: true, status: "Pago" };
  if (!(p.status === "PENDING" || p.status === "OVERDUE")) throw new CheckoutError("Essa cobrança não está mais em aberto.");
  const charge = cardCharge(raw, (await payerOf(userId)) ?? {}, remoteIp);
  // boleto ou Pix escolhido antes: volta para "qualquer forma" para aceitar o cartão
  if (p.billingType === "BOLETO" || p.billingType === "PIX") await asaas("POST", `/payments/${p.id}`, { billingType: "UNDEFINED", value: Number(p.value), dueDate: p.dueDate });
  let r: any;
  try {
    r = await asaas("POST", `/payments/${p.id}/payWithCreditCard`, { creditCard: charge.creditCard, creditCardHolderInfo: charge.creditCardHolderInfo, remoteIp });
  } catch (err) {
    throw new CheckoutError(cardRefusal(err as Error));
  }
  const paid = await settle({ ...p, ...r, subscription: r?.subscription ?? p.subscription, externalReference: r?.externalReference ?? p.externalReference });
  return { paid, status: PAYMENT_STATUS[String(r?.status ?? "")] ?? String(r?.status ?? "") };
}

/** Recusa do cartão em português simples (o Asaas manda o motivo; sem motivo, o texto padrão). */
export const cardRefusal = (err: Error) =>
  /não autorizad|recusad|negad|denied|declin/i.test(err.message) || !err.message
    ? "O cartão não passou. Confira os dados ou tente outro cartão, Pix ou boleto."
    : err.message;

/** O que está à venda no checkout de quem está logado (plano para assinar ou pacote), com o preço que vai ser cobrado. */
export async function checkoutItem(kind: string, id: string, discountPercent: number) {
  const s = await getSettings();
  if (!s.billingEnabled) throw new CheckoutError("A cobrança ainda não está ligada.");
  if (kind === "plan") {
    const plan = planById(s, id);
    if (!plan) throw new CheckoutError("Plano não encontrado.", 404);
    const value = Math.round(plan.price * (100 - discountPercent)) / 100;
    return {
      kind: "plan" as const,
      id: plan.id,
      title: `Plano ${plan.name}`,
      value,
      fullPrice: plan.price,
      discount: discountPercent,
      grains: plan.grains,
      recurring: true,
      perks: [`${grains(plan.grains)} por mês`, ...perksOf(plan).slice(0, 3)],
    };
  }
  const pack = packById(s, id);
  if (!pack) throw new CheckoutError("Pacote não encontrado.", 404);
  return {
    kind: "pack" as const,
    id: pack.id,
    title: `Pacote de ${grains(pack.grains)}`,
    value: pack.price,
    fullPrice: pack.price,
    discount: 0,
    grains: pack.grains,
    recurring: false,
    perks: ["Entram na hora em que o pagamento cai", "Não vencem"],
  };
}
