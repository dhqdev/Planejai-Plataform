import { asaas, ensureCustomer, getSubscription, validCpfCnpj } from "./billing.js";
import { tellPerson } from "./credits.js";
import { decryptJson, encryptJson } from "./crypto.js";
import { many, one, pool, query } from "./db/pool.js";
import { isOwner } from "./ingest.js";
import { getCredentials } from "./integrations/registry.js";
import { notify } from "./notifications.js";
import { parsePixCode } from "./pixcode.js";
import { type AgentSettings, getSettings } from "./settings.js";

/**
 * Compras pelo assistente. O agente acha o produto, entra na conta da pessoa na loja (login que ela fez pelo painel),
 * monta o carrinho e escolhe Pix no checkout. O código Pix da loja é a fonte do valor: o servidor lê o total dele,
 * soma a taxa e pede o "sim" com o valor exato. Depois sai de um de três jeitos:
 * - pix: o código vai para a pessoa pagar do banco dela. Dinheiro nunca passa por aqui, sem taxa.
 * - card: cobra no cartão dela pelo Asaas (primeira vez na página do Asaas; depois pelo token salvo) e, aprovado,
 *   paga o Pix da loja da conta Asaas do dono. Falhou depois de cobrar: estorna sozinho.
 * - wallet: reserva do saldo (carregado só por Pix), paga o Pix da loja e a reserva vira débito. Falhou: a reserva volta.
 * Tudo em centavos. Nenhum valor vem do modelo: o total sai do código Pix (conferido de novo na hora de pagar).
 */

export type PurchaseMethod = "pix" | "card" | "wallet";

/** Versão dos Termos de compra: mudou o texto, sobe a data e todo mundo aceita de novo. */
export const TERMS_VERSION = "2026-10-09";

export const STORES: Record<string, { name: string; domains: string[]; home: string }> = {
  mercadolivre: { name: "Mercado Livre", domains: ["mercadolivre.com.br", "mercadolivre.com", "mercadolibre.com", "mercadopago.com.br"], home: "https://www.mercadolivre.com.br/" },
  shopee: { name: "Shopee", domains: ["shopee.com.br"], home: "https://shopee.com.br/buyer/login" },
  amazon: { name: "Amazon", domains: ["amazon.com.br"], home: "https://www.amazon.com.br/" },
  magalu: { name: "Magalu", domains: ["magazineluiza.com.br", "magalu.com"], home: "https://www.magazineluiza.com.br/" },
};

const hostMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** Loja conhecida de uma URL ("mercadolivre"), ou null. */
export function storeOf(url: string | null | undefined): string | null {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return Object.entries(STORES).find(([, s]) => s.domains.some((d) => hostMatches(host, d)))?.[0] ?? null;
  } catch {
    return null;
  }
}

export const brl = (cents: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100).replace(/ /g, " ");

const METHOD_TXT: Record<PurchaseMethod, string> = { pix: "Pix direto", card: "cartão", wallet: "saldo" };

// ---------------- Dados de compra da pessoa ----------------

export interface BuyerData {
  full_name: string;
  cpf: string;
  birth_date: string;
  address: { cep: string; street: string; number: string; complement?: string; district: string; city: string; state: string };
}

const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const clip = (s: unknown, n = 120) => String(s ?? "").trim().slice(0, n);

/** Confere e limpa o que veio do formulário. Erro com texto pronto para a tela. */
export function cleanBuyerData(raw: any): BuyerData {
  const full_name = clip(raw?.full_name, 100).replace(/\s+/g, " ");
  if (full_name.split(" ").length < 2) throw new Error("Informe o nome completo, como no documento.");
  const cpf = digits(raw?.cpf);
  if (cpf.length !== 11 || !validCpfCnpj(cpf)) throw new Error("CPF inválido.");
  const birth = String(raw?.birth_date ?? "").slice(0, 10);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(birth) ? new Date(`${birth}T12:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime())) throw new Error("Data de nascimento inválida.");
  const age = (Date.now() - d.getTime()) / (365.25 * 86_400_000);
  if (age < 18) throw new Error("Compras pelo assistente são só para maiores de 18 anos.");
  if (age > 120) throw new Error("Data de nascimento inválida.");
  const a = raw?.address ?? {};
  const address = {
    cep: digits(a.cep),
    street: clip(a.street),
    number: clip(a.number, 20),
    complement: clip(a.complement, 60) || undefined,
    district: clip(a.district, 80),
    city: clip(a.city, 80),
    state: clip(a.state, 2).toUpperCase(),
  };
  if (address.cep.length !== 8) throw new Error("CEP precisa ter 8 números.");
  if (!address.street || !address.number || !address.district || !address.city || !/^[A-Z]{2}$/.test(address.state)) {
    throw new Error("Complete o endereço de entrega (rua, número, bairro, cidade e UF).");
  }
  return { full_name, cpf, birth_date: birth, address };
}

interface ProfileRow {
  user_id: string;
  data: string | null;
  cpf_end: string | null;
  city: string | null;
  terms_version: string | null;
  terms_accepted_at: string | null;
  card_token: string | null;
  card_brand: string | null;
  card_last4: string | null;
  remote_ip: string | null;
}

async function profileRow(userId: string) {
  return (await one<ProfileRow>("SELECT * FROM buyer_profiles WHERE user_id = $1", [userId])) ?? null;
}

export function buyerData(row: ProfileRow | null): BuyerData | null {
  if (!row?.data) return null;
  try {
    return decryptJson<BuyerData>(row.data);
  } catch {
    return null;
  }
}

const termsOk = (row: ProfileRow | null) => row?.terms_version === TERMS_VERSION && Boolean(row.terms_accepted_at);

/** O que a tela mostra: CPF só o final, endereço inteiro (é da própria pessoa). */
export async function buyerProfile(userId: string) {
  const row = await profileRow(userId);
  const d = buyerData(row);
  return {
    filled: Boolean(d),
    full_name: d?.full_name ?? "",
    cpf_end: row?.cpf_end ?? null,
    birth_date: d?.birth_date ?? "",
    address: d?.address ?? null,
    terms: { version: TERMS_VERSION, accepted: termsOk(row), accepted_at: row?.terms_accepted_at ?? null },
    card: row?.card_last4 ? { brand: row.card_brand, last4: row.card_last4 } : null,
  };
}

export async function saveBuyerProfile(userId: string, raw: any, ip?: string | null) {
  // CPF em branco na edição: mantém o que já estava (a tela mostra só o final)
  const before = buyerData(await profileRow(userId));
  const d = cleanBuyerData({ ...raw, cpf: String(raw?.cpf ?? "").replace(/\D/g, "") ? raw.cpf : before?.cpf });
  await query(
    `INSERT INTO buyer_profiles (user_id, data, cpf_end, city, remote_ip) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET data = $2, cpf_end = $3, city = $4, remote_ip = COALESCE($5, buyer_profiles.remote_ip), updated_at = now()`,
    [userId, encryptJson(d), d.cpf.slice(-2), `${d.address.city}/${d.address.state}`, ip ?? null],
  );
  return buyerProfile(userId);
}

export async function acceptPurchaseTerms(userId: string, ip?: string | null) {
  await query(
    `INSERT INTO buyer_profiles (user_id, terms_version, terms_accepted_at, remote_ip) VALUES ($1, $2, now(), $3)
     ON CONFLICT (user_id) DO UPDATE SET terms_version = $2, terms_accepted_at = now(), remote_ip = COALESCE($3, buyer_profiles.remote_ip), updated_at = now()`,
    [userId, TERMS_VERSION, ip ?? null],
  );
  return buyerProfile(userId);
}

/** Tira o cartão salvo (o token some daqui; no Asaas ele não cobra nada sozinho). */
export async function forgetCard(userId: string) {
  await query("UPDATE buyer_profiles SET card_token = NULL, card_brand = NULL, card_last4 = NULL, updated_at = now() WHERE user_id = $1", [userId]);
}

// ---------------- Regras do dono ----------------

export function purchaseRules(s: AgentSettings) {
  const methods = { pix: Boolean(s.purchasePix), card: Boolean(s.purchaseCard), wallet: Boolean(s.purchaseWallet) };
  return {
    enabled: Boolean(s.purchasesEnabled) && Object.values(methods).some(Boolean),
    methods,
    feePercent: Number(s.purchaseFeePercent ?? 0),
    feeMinCents: Number(s.purchaseFeeMinCents ?? 0),
    maxCents: Number(s.purchaseMaxCents ?? 0),
    monthMaxCents: Number(s.purchaseMonthMaxCents ?? 0),
    walletMaxCents: Number(s.purchaseWalletMaxCents ?? 0),
    cardNeedsPlan: Boolean(s.purchaseCardNeedsPlan),
    termsVersion: TERMS_VERSION,
    stores: Object.entries(STORES).map(([id, st]) => ({ id, name: st.name })),
  };
}

/** Taxa de serviço em centavos: Pix direto não tem; cartão e saldo pagam a % do dono, com mínimo. */
export function feeFor(storeCents: number, method: PurchaseMethod, s: AgentSettings) {
  if (method === "pix") return 0;
  const pct = Math.round((storeCents * Number(s.purchaseFeePercent ?? 0)) / 100);
  return Math.max(pct, Number(s.purchaseFeeMinCents ?? 0));
}

/** Quanto a pessoa já comprou nos últimos 30 dias (valor da loja), contando só o que não falhou. */
export async function spentLast30(userId: string) {
  const r = await one<{ v: number }>(
    `SELECT COALESCE(SUM(store_cents), 0)::int AS v FROM purchases
      WHERE user_id = $1 AND created_at > now() - interval '30 days' AND status NOT IN ('awaiting_confirm', 'failed', 'refunded', 'canceled')`,
    [userId],
  );
  return r?.v ?? 0;
}

// ---------------- Saldo de compras ----------------

export async function shopWallet(userId: string) {
  const w = await one("SELECT balance_cents, held_cents FROM shop_wallets WHERE user_id = $1", [userId]);
  return { balance: Number(w?.balance_cents ?? 0), held: Number(w?.held_cents ?? 0) };
}

/** Move o saldo numa transação, com a entrada do extrato uma vez só por (tipo, ref). false = já feito ou sem saldo. */
async function walletMove(userId: string, kind: "recarga" | "reserva" | "devolucao" | "compra" | "ajuste", ref: string, balanceDelta: number, heldDelta: number, note?: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO shop_wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
    const w = (await client.query("SELECT balance_cents, held_cents FROM shop_wallets WHERE user_id = $1 FOR UPDATE", [userId])).rows[0];
    if (Number(w.balance_cents) + balanceDelta < 0 || Number(w.held_cents) + heldDelta < 0) {
      await client.query("ROLLBACK");
      return false;
    }
    const logged = await client.query("INSERT INTO shop_ledger (user_id, kind, delta_cents, ref, note) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id", [
      userId,
      kind,
      balanceDelta,
      ref,
      note ?? null,
    ]);
    if (!logged.rowCount) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("UPDATE shop_wallets SET balance_cents = balance_cents + $2, held_cents = held_cents + $3, updated_at = now() WHERE user_id = $1", [userId, balanceDelta, heldDelta]);
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Recarga do saldo: só Pix (cai na hora e não tem estorno de cartão). Devolve o link da cobrança do Asaas. */
export async function createTopup(user: any, cents: number) {
  const s = await getSettings();
  const rules = purchaseRules(s);
  if (!rules.enabled || !rules.methods.wallet) throw new Error("O saldo para compras não está ligado.");
  cents = Math.round(Number(cents));
  if (!Number.isInteger(cents) || cents < 500) throw new Error("A recarga mínima é de R$ 5,00.");
  const row = await profileRow(user.id);
  const d = buyerData(row);
  if (!d || !termsOk(row)) throw new Error("Preencha seus dados e aceite os Termos de compra antes de carregar saldo.");
  const w = await shopWallet(user.id);
  if (w.balance + w.held + cents > rules.walletMaxCents) throw new Error(`O saldo máximo é de ${brl(rules.walletMaxCents)}.`);
  const customer = await ensureCustomer(user, { name: d.full_name, cpfCnpj: d.cpf });
  const top = await one("INSERT INTO shop_topups (user_id, value_cents) VALUES ($1, $2) RETURNING *", [user.id, cents]);
  const payment = await asaas("POST", "/payments", {
    customer,
    billingType: "PIX",
    value: cents / 100,
    dueDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    description: `Planejai: saldo para compras (${brl(cents)})`,
    externalReference: `topup:${top.id}`,
  });
  return one("UPDATE shop_topups SET asaas_payment_id = $2, invoice_url = $3 WHERE id = $1 RETURNING *", [top.id, String(payment.id), payment.invoiceUrl ?? null]);
}

// ---------------- Código Pix da loja ----------------

export interface CheckedPix {
  payload: string;
  cents: number;
  receiver: string | null;
  expiresAt: string | null;
}

/**
 * Lê o código Pix da loja e acha o valor. Com o Asaas conectado, quem manda é o decode dele (é o que vai ser pago);
 * o valor escrito no código precisa bater. Sem Asaas (só Pix direto), vale o valor escrito no código.
 */
export async function checkStorePix(raw: string, opts: { needAsaas: boolean }): Promise<CheckedPix> {
  const code = parsePixCode(raw);
  if (!code) throw new Error("O código Pix está incompleto ou não é um Pix copia e cola. Copie de novo o código inteiro do checkout.");
  const connected = Boolean((await getCredentials("asaas").catch(() => null))?.api_key);
  if (!connected) {
    if (opts.needAsaas) throw new Error("Asaas não conectado: só o Pix direto funciona agora.");
    if (!code.cents) throw new Error("Esse Pix não traz o valor escrito no código. Sem o Asaas conectado não dá para conferir o total.");
    return { payload: code.payload, cents: code.cents, receiver: code.receiver, expiresAt: null };
  }
  const dec: any = await asaas("POST", "/pix/qrCodes/decode", { payload: code.payload });
  const value = Number(dec?.totalValue ?? dec?.value ?? 0);
  const cents = Math.round(value * 100);
  if (!(cents > 0)) throw new Error("O Asaas não achou o valor desse Pix. Gere o código de novo no checkout.");
  if (code.cents && code.cents !== cents) throw new Error("O valor escrito no Pix não bate com o da cobrança. Gere o código de novo no checkout.");
  if (dec?.canBePaid === false) throw new Error(`Esse Pix não pode ser pago agora${dec?.cannotBePaidReason ? `: ${dec.cannotBePaidReason}` : ""}. Gere outro no checkout.`);
  return { payload: code.payload, cents, receiver: dec?.receiver?.name ?? code.receiver, expiresAt: dec?.expirationDate ?? dec?.dueDate ?? null };
}

// ---------------- Compra ----------------

export interface PurchaseRow {
  id: string;
  user_id: string;
  store: string;
  title: string;
  url: string | null;
  method: PurchaseMethod;
  store_cents: number;
  fee_cents: number;
  total_cents: number;
  store_pix: string;
  store_receiver: string | null;
  status: string;
  asaas_payment_id: string | null;
  invoice_url: string | null;
  pix_tx_id: string | null;
  order_ref: string | null;
  tracking: string | null;
  error: string | null;
  created_at: string;
}

export const STATUS_TXT: Record<string, string> = {
  awaiting_confirm: "esperando o sim",
  awaiting_person: "esperando você pagar o Pix",
  charging: "esperando o cartão",
  charged: "pago, finalizando na loja",
  paying_store: "pagando a loja",
  paid: "pago na loja",
  delivered: "entregue",
  failed: "não deu certo",
  refunded: "estornado",
  canceled: "cancelado",
};

/** Pode usar esse jeito de pagar agora? Devolve o motivo quando não pode. */
async function blockedReason(user: any, method: PurchaseMethod, storeCents: number, totalCents: number, s: AgentSettings, row: ProfileRow | null) {
  const rules = purchaseRules(s);
  if (!rules.enabled) return "Compras pelo assistente ainda não estão ligadas.";
  if (!rules.methods[method]) return `Pagar com ${METHOD_TXT[method]} não está ligado. Jeitos ligados: ${(Object.keys(rules.methods) as PurchaseMethod[]).filter((m) => rules.methods[m]).map((m) => METHOD_TXT[m]).join(", ")}.`;
  if (!termsOk(row)) return "A pessoa ainda não aceitou os Termos de compra: peça para ela abrir Compras no painel e aceitar.";
  if (storeCents > rules.maxCents) return `Passa do limite por compra (${brl(rules.maxCents)}).`;
  if ((await spentLast30(user.id)) + storeCents > rules.monthMaxCents) return `Passa do limite de ${brl(rules.monthMaxCents)} em 30 dias.`;
  if (method === "pix") return null;
  if (!buyerData(row)) return "Faltam os dados de compra (nome, CPF, nascimento e endereço): peça para ela preencher em Compras no painel.";
  if (method === "card" && rules.cardNeedsPlan && !isOwner(user.phone) && !user.billing_exempt) {
    const sub = await getSubscription(user.id);
    if (!sub?.last_payment_at) return "Compra no cartão é só para quem já pagou um plano. Dá para usar o Pix direto.";
  }
  if (method === "wallet") {
    const w = await shopWallet(user.id);
    if (w.balance < totalCents) return `Saldo insuficiente: tem ${brl(w.balance)} e a compra dá ${brl(totalCents)}. Dá para carregar por Pix em Compras.`;
  }
  return null;
}

/**
 * Primeiro passo (o agente chama com o Pix do checkout): confere tudo e guarda a compra esperando o "sim".
 * Devolve o resumo exato que vai na pergunta.
 */
export async function preparePurchase(userId: string, input: { title: string; url?: string; store?: string; pix_code: string; method: PurchaseMethod }) {
  const s = await getSettings();
  const user = await one("SELECT * FROM users WHERE id = $1", [userId]);
  if (!user) throw new Error("Pessoa não encontrada.");
  const method: PurchaseMethod = (["pix", "card", "wallet"] as const).includes(input.method) ? input.method : "pix";
  const title = clip(input.title, 140);
  if (!title) throw new Error("Diga o que está sendo comprado (title).");
  const store = storeOf(input.url) ?? (input.store && STORES[input.store] ? input.store : null) ?? clip(input.store, 40).toLowerCase();
  if (!store) throw new Error("Qual loja? Mande a url do produto.");
  const row = await profileRow(user.id);
  const early = await blockedReason(user, method, 1, 1, s, row);
  if (early) throw new Error(early);
  const pix = await checkStorePix(input.pix_code, { needAsaas: method !== "pix" });
  const fee = feeFor(pix.cents, method, s);
  const total = pix.cents + fee;
  const why = await blockedReason(user, method, pix.cents, total, s, row);
  if (why) throw new Error(why);
  // o mesmo Pix pedido de novo substitui o pedido anterior
  await query("UPDATE purchases SET status = 'canceled', updated_at = now() WHERE user_id = $1 AND status = 'awaiting_confirm'", [user.id]);
  const p = await one<PurchaseRow>(
    `INSERT INTO purchases (user_id, store, title, url, method, store_cents, fee_cents, total_cents, store_pix, store_receiver, pix_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [user.id, store, title, input.url ? clip(input.url, 500) : null, method, pix.cents, fee, total, pix.payload, pix.receiver, pix.expiresAt],
  );
  return { purchase: p!, summary: purchaseSummary(p!, row) };
}

export function purchaseSummary(p: PurchaseRow, row?: ProfileRow | null) {
  const where = STORES[p.store]?.name ?? p.store;
  const who = p.store_receiver ? ` (Pix para ${p.store_receiver})` : "";
  if (p.method === "pix") return `comprar "${p.title}" no ${where} por ${brl(p.store_cents)}${who}, com o Pix da loja pago por ela no banco dela (sem taxa)`;
  const fee = `${brl(p.store_cents)} + ${brl(p.fee_cents)} de taxa = ${brl(p.total_cents)}`;
  if (p.method === "card") return `comprar "${p.title}" no ${where}${who}: ${fee} no cartão${row?.card_last4 ? ` final ${row.card_last4}` : " (o link do cartão vai em seguida)"}`;
  return `comprar "${p.title}" no ${where}${who}: ${fee} do seu saldo`;
}

/** A pessoa disse "sim" (conferido pelo servidor): executa a compra guardada. Devolve o que contar a ela. */
export async function approvePurchase(userId: string, purchaseId: string): Promise<{ ok: boolean; say: string }> {
  const gone = { ok: false, say: "Esse pedido de compra já foi resolvido ou expirou. Se ainda quer, é só pedir de novo." };
  const user = await one("SELECT * FROM users WHERE id = $1", [userId]);
  const waiting = await one<PurchaseRow>("SELECT * FROM purchases WHERE id::text = $1 AND user_id = $2 AND status = 'awaiting_confirm'", [purchaseId, userId]);
  if (!user || !waiting) return gone;
  const s = await getSettings();
  const row = await profileRow(userId);
  // as regras valem de novo na hora do sim (o dono pode ter mudado, o saldo pode ter mexido)
  const why = await blockedReason(user, waiting.method, waiting.store_cents, waiting.total_cents, s, row);
  if (why) {
    await query("UPDATE purchases SET status = 'canceled', error = $2, updated_at = now() WHERE id = $1 AND status = 'awaiting_confirm'", [waiting.id, why]);
    return { ok: false, say: why };
  }
  // um "sim" só: duas execuções ao mesmo tempo, só uma passa daqui
  const p = await one<PurchaseRow>("UPDATE purchases SET status = 'approved', updated_at = now() WHERE id = $1 AND status = 'awaiting_confirm' RETURNING *", [waiting.id]);
  if (!p) return gone;
  if (p.method === "pix") {
    await setStatus(p.id, "awaiting_person");
    // o código vai sozinho numa mensagem, para copiar sem nada em volta
    await tellPerson(user.id, p.store_pix, "compras", "/compras");
    return { ok: true, say: `Mandei o código Pix (copia e cola) de ${brl(p.store_cents)}. Quando pagar no seu banco, o pedido segue na loja e eu acompanho.` };
  }
  if (p.method === "wallet") {
    const held = await walletMove(user.id, "reserva", p.id, -p.total_cents, p.total_cents, p.title);
    if (!held) {
      await setStatus(p.id, "canceled", { error: "saldo insuficiente" });
      return { ok: false, say: "O saldo não cobre essa compra. Dá para carregar por Pix em Compras no painel." };
    }
    await setStatus(p.id, "charged");
    return payStore(p.id);
  }
  return chargeCard(user, p, row);
}

async function setStatus(id: string, status: string, extra: Record<string, unknown> = {}) {
  const cols = Object.keys(extra);
  return one<PurchaseRow>(
    `UPDATE purchases SET status = $2${cols.map((c, i) => `, ${c} = $${i + 3}`).join("")}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, status, ...Object.values(extra)],
  );
}

const today = () => new Date().toISOString().slice(0, 10);

/** Cobra no cartão: pelo token salvo, na hora; sem token, manda o link seguro do Asaas e o webhook continua. */
async function chargeCard(user: any, p: PurchaseRow, row: ProfileRow | null): Promise<{ ok: boolean; say: string }> {
  const d = buyerData(row)!;
  const customer = await ensureCustomer(user, { name: d.full_name, cpfCnpj: d.cpf });
  const base = {
    customer,
    billingType: "CREDIT_CARD",
    value: p.total_cents / 100,
    dueDate: today(),
    description: `Planejai: ${p.title.slice(0, 80)} (${STORES[p.store]?.name ?? p.store})`,
    externalReference: `purchase:${p.id}`,
  };
  const token = row?.card_token ? (() => { try { return decryptJson<{ token: string }>(row.card_token!).token; } catch { return null; } })() : null;
  if (token && row?.remote_ip) {
    let pay: any;
    try {
      pay = await asaas("POST", "/payments", { ...base, creditCardToken: token, remoteIp: row.remote_ip });
    } catch (err) {
      await setStatus(p.id, "failed", { error: (err as Error).message.slice(0, 300) });
      return { ok: false, say: `O cartão final ${row.card_last4} não passou (${(err as Error).message}). Nada foi cobrado. Dá para tentar o Pix direto.` };
    }
    await setStatus(p.id, "charging", { asaas_payment_id: String(pay.id), invoice_url: pay.invoiceUrl ?? null });
    if (pay.status === "CONFIRMED" || pay.status === "RECEIVED") {
      const charged = await one("UPDATE purchases SET status = 'charged', updated_at = now() WHERE id = $1 AND status = 'charging' RETURNING id", [p.id]);
      if (charged) return payStore(p.id);
    }
    return { ok: true, say: "Cobrança no cartão enviada. Assim que aprovar eu pago a loja e te aviso." };
  }
  const pay = await asaas("POST", "/payments", base);
  await setStatus(p.id, "charging", { asaas_payment_id: String(pay.id), invoice_url: pay.invoiceUrl ?? null });
  await tellPerson(user.id, `Para pagar no cartão, coloque os dados nesta página segura do Asaas (o número do cartão não passa pelo Planejai): ${pay.invoiceUrl}`, "compras", "/compras");
  return { ok: true, say: `Mandei o link seguro do Asaas para pagar ${brl(p.total_cents)} no cartão. Assim que aprovar, eu pago a loja e te aviso. O cartão fica salvo para as próximas.` };
}

const PIX_DONE = new Set(["DONE"]);
const PIX_FAILED = new Set(["REFUSED", "ERROR", "CANCELLED"]);

/** Paga o Pix da loja pela conta Asaas do dono. Só sai de "charged" (cartão aprovado ou saldo reservado), uma vez. */
export async function payStore(purchaseId: string): Promise<{ ok: boolean; say: string }> {
  const p = await one<PurchaseRow>("UPDATE purchases SET status = 'paying_store', updated_at = now() WHERE id = $1 AND status = 'charged' RETURNING *", [purchaseId]);
  if (!p) return { ok: true, say: "Essa compra já está sendo paga." };
  let tx: any;
  try {
    // confere de novo na hora: o valor tem que ser exatamente o aprovado e o Pix ainda pode ser pago
    const again = await checkStorePix(p.store_pix, { needAsaas: true });
    if (again.cents !== p.store_cents) throw new Error(`o valor do Pix mudou para ${brl(again.cents)}`);
    tx = await asaas("POST", "/pix/qrCodes/pay", { qrCode: { payload: p.store_pix }, value: p.store_cents / 100, description: `Planejai ${p.id.slice(0, 8)}` });
  } catch (err) {
    return failPurchase(p.id, (err as Error).message);
  }
  await query("UPDATE purchases SET pix_tx_id = $2, updated_at = now() WHERE id = $1", [p.id, String(tx?.id ?? "")]);
  const st = String(tx?.status ?? "");
  if (PIX_FAILED.has(st)) return failPurchase(p.id, `o Pix da loja foi recusado (${st})`);
  if (PIX_DONE.has(st)) return storePaid(p.id);
  return { ok: true, say: "Pagamento da loja enviado. Te aviso assim que ela confirmar o pedido." };
}

async function storePaid(purchaseId: string): Promise<{ ok: boolean; say: string }> {
  const p = await one<PurchaseRow>("UPDATE purchases SET status = 'paid', paid_at = now(), updated_at = now() WHERE id = $1 AND status = 'paying_store' RETURNING *", [purchaseId]);
  if (!p) return { ok: true, say: "Compra já paga." };
  // saldo: a reserva vira débito de vez
  if (p.method === "wallet") await walletMove(p.user_id, "compra", p.id, 0, -p.total_cents, p.title);
  const where = STORES[p.store]?.name ?? p.store;
  const say = `Pronto, paguei ${brl(p.store_cents)} no ${where} pelo "${p.title}". O pedido aparece na sua conta da loja e eu aviso quando tiver rastreio.`;
  await tellPerson(p.user_id, say, "compras", "/compras");
  await notify({ userId: null, kind: "compras", title: `Compra paga: ${brl(p.total_cents)}`, body: `${p.title} (${where}), ${METHOD_TXT[p.method]}. Taxa ${brl(p.fee_cents)}.`, link: "/compras" });
  return { ok: true, say };
}

/** Deu errado depois de cobrar/reservar: devolve tudo e avisa a pessoa e o dono. */
export async function failPurchase(purchaseId: string, reason: string): Promise<{ ok: boolean; say: string }> {
  const p = await one<PurchaseRow>(
    "UPDATE purchases SET status = 'failed', error = $2, updated_at = now() WHERE id = $1 AND status IN ('charged', 'paying_store') RETURNING *",
    [purchaseId, reason.slice(0, 300)],
  );
  if (!p) return { ok: false, say: "Essa compra já tinha sido encerrada." };
  let back = "";
  if (p.method === "wallet") {
    await walletMove(p.user_id, "devolucao", p.id, p.total_cents, -p.total_cents, p.title);
    back = ` Os ${brl(p.total_cents)} voltaram para o seu saldo.`;
  } else if (p.method === "card" && p.asaas_payment_id) {
    const refunded = await asaas("POST", `/payments/${p.asaas_payment_id}/refund`, {}).then(
      () => true,
      (err: Error) => (console.error("[compras] estorno falhou", p.id, err.message), false),
    );
    if (refunded) {
      await setStatus(p.id, "refunded");
      back = ` Estornei ${brl(p.total_cents)} no seu cartão (pode levar alguns dias para aparecer na fatura).`;
    } else back = " O estorno no cartão vai ser feito pelo suporte.";
  }
  const say = `Não consegui pagar a loja (${reason}).${back} Se ainda quiser, peça de novo que eu refaço o carrinho.`;
  await tellPerson(p.user_id, say, "compras", "/compras");
  await notify({ userId: null, kind: "compras", title: "Compra não concluída", body: `${p.title}: ${reason}.${back}`, link: "/compras" });
  return { ok: false, say };
}

/** Evento do Asaas de uma compra no cartão ou de uma recarga do saldo. */
export async function handlePurchasePayment(event: string, pay: any): Promise<{ handled: boolean; status?: string }> {
  const ref = String(pay?.externalReference ?? "");
  const paid = ["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"].includes(event);
  if (ref.startsWith("topup:")) {
    const top = await one("SELECT * FROM shop_topups WHERE id::text = $1", [ref.slice(6)]);
    if (!top) return { handled: false };
    if (paid) {
      const done = await one("UPDATE shop_topups SET status = 'paid', paid_at = now() WHERE id = $1 AND status <> 'paid' RETURNING *", [top.id]);
      if (done && (await walletMove(top.user_id, "recarga", top.id, Number(top.value_cents), 0, "Pix"))) {
        const w = await shopWallet(top.user_id);
        await tellPerson(top.user_id, `Recarga de ${brl(Number(top.value_cents))} confirmada! Seu saldo para compras agora é ${brl(w.balance)}.`, "compras", "/compras");
      }
      return { handled: true, status: "paid" };
    }
    if (event === "PAYMENT_OVERDUE" || event === "PAYMENT_DELETED") await query("UPDATE shop_topups SET status = 'canceled' WHERE id = $1 AND status = 'pending'", [top.id]);
    if (event === "PAYMENT_REFUNDED") {
      await query("UPDATE shop_topups SET status = 'refunded' WHERE id = $1", [top.id]);
      await notify({ userId: null, kind: "compras", title: "Recarga de saldo estornada", body: `${brl(Number(top.value_cents))}. Confira o saldo da pessoa em Compras.`, link: "/compras" });
    }
    return { handled: true, status: top.status };
  }
  const p = await one<PurchaseRow>("SELECT * FROM purchases WHERE id::text = $1", [ref.slice(9)]);
  if (!p) return { handled: false };
  if (paid) {
    // cartão salvo para a próxima: só o token (criptografado), a bandeira e o final
    const card = pay?.creditCard ?? {};
    if (card.creditCardToken) {
      await query(
        `UPDATE buyer_profiles SET card_token = $2, card_brand = $3, card_last4 = $4, updated_at = now() WHERE user_id = $1`,
        [p.user_id, encryptJson({ token: String(card.creditCardToken) }), String(card.creditCardBrand ?? "").slice(0, 20) || null, String(card.creditCardNumber ?? "").slice(-4) || null],
      );
    }
    const charged = await one("UPDATE purchases SET status = 'charged', updated_at = now() WHERE id = $1 AND status = 'charging' RETURNING id", [p.id]);
    if (charged) await payStore(p.id);
    return { handled: true, status: "charged" };
  }
  if (["PAYMENT_CREDIT_CARD_CAPTURE_REFUSED", "PAYMENT_REPROVED_BY_RISK_ANALYSIS", "PAYMENT_OVERDUE", "PAYMENT_DELETED"].includes(event)) {
    const r = await one("UPDATE purchases SET status = 'failed', error = $2, updated_at = now() WHERE id = $1 AND status = 'charging' RETURNING id", [p.id, event]);
    if (r) await tellPerson(p.user_id, `O cartão não passou na compra do "${p.title}", então nada foi comprado. Dá para tentar de novo ou usar o Pix direto.`, "compras", "/compras");
    return { handled: true, status: "failed" };
  }
  if (event === "PAYMENT_REFUNDED" || event === "PAYMENT_CHARGEBACK_REQUESTED") {
    if (event === "PAYMENT_CHARGEBACK_REQUESTED") {
      await notify({ userId: null, kind: "compras", title: "Contestação no cartão de uma compra", body: `${p.title}: ${brl(p.total_cents)}. Junte o comprovante de entrega no Asaas.`, link: "/compras" });
    }
    return { handled: true, status: p.status };
  }
  return { handled: true, status: p.status };
}

/**
 * Mecanismo de validação de saque do Asaas: antes de cada saída de dinheiro, o Asaas pergunta aqui.
 * Só aprova o Pix de loja que o próprio servidor mandou pagar, com o valor exato. Todo o resto é recusado.
 */
export async function validateWithdrawal(body: any): Promise<{ status: "APPROVED" } | { status: "REFUSED"; refuseReason: string }> {
  if (body?.type !== "PIX_QR_CODE") return { status: "REFUSED", refuseReason: "Saída não criada pelo Planejai" };
  const tx = body.pixQrCode ?? {};
  const id = String(tx.id ?? "");
  // o Asaas pergunta uns segundos depois de criar; dá uma folga para o id ser gravado
  let p: PurchaseRow | null = null;
  for (let i = 0; i < 4 && !p; i++) {
    p = id ? ((await one<PurchaseRow>("SELECT * FROM purchases WHERE pix_tx_id = $1 AND status = 'paying_store'", [id])) ?? null) : null;
    if (!p && i < 3) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!p) return { status: "REFUSED", refuseReason: "Pix não encontrado no Planejai" };
  if (Math.round(Number(tx.value) * 100) !== p.store_cents) return { status: "REFUSED", refuseReason: "Valor diferente do aprovado" };
  return { status: "APPROVED" };
}

/** Rodada de poucos minutos: Pix de loja que ainda não confirmou e compras esquecidas no meio. */
export async function checkOpenPurchases(log?: { info: (...a: any[]) => void; error: (...a: any[]) => void }) {
  const open = await many<PurchaseRow & { age_min: number }>(
    `SELECT *, EXTRACT(EPOCH FROM now() - updated_at)::int / 60 AS age_min FROM purchases
      WHERE status IN ('paying_store', 'charged', 'charging') ORDER BY updated_at LIMIT 50`,
  );
  for (const p of open) {
    try {
      if (p.status === "paying_store" && p.pix_tx_id) {
        const tx: any = await asaas("GET", `/pix/transactions/${p.pix_tx_id}`);
        const st = String(tx?.status ?? "");
        if (PIX_DONE.has(st)) await storePaid(p.id);
        else if (PIX_FAILED.has(st)) await failPurchase(p.id, `o Pix da loja foi recusado (${st})`);
      } else if (p.status === "paying_store" && p.age_min >= 10) {
        await failPurchase(p.id, "o pagamento da loja não saiu");
      } else if (p.status === "charged" && p.age_min >= 2) {
        await payStore(p.id);
      } else if (p.status === "charging" && p.age_min >= 24 * 60) {
        // link do cartão aberto há um dia: o Pix da loja já venceu
        await query("UPDATE purchases SET status = 'canceled', error = 'cartão não pago a tempo', updated_at = now() WHERE id = $1 AND status = 'charging'", [p.id]);
        if (p.asaas_payment_id) await asaas("DELETE", `/payments/${p.asaas_payment_id}`).catch(() => {});
      }
    } catch (err) {
      log?.error({ err, purchaseId: p.id }, "conferência de compra falhou");
    }
  }
  // pedidos sem "sim" por mais de 30 minutos caem
  await query("UPDATE purchases SET status = 'canceled', updated_at = now() WHERE status = 'awaiting_confirm' AND created_at < now() - interval '30 minutes'");
  return { checked: open.length };
}

/** Pedido ou rastreio que o agente viu na loja; ou a pessoa disse que pagou o Pix direto / recebeu. */
export async function updatePurchase(userId: string, id: string, patch: { order_ref?: string; tracking?: string; status?: "paid" | "delivered" | "canceled" }) {
  const p = await one<PurchaseRow>("SELECT * FROM purchases WHERE id::text = $1 AND user_id = $2", [id, userId]);
  if (!p) throw new Error("Compra não encontrada.");
  const sets: Record<string, unknown> = {};
  if (patch.order_ref) sets.order_ref = clip(patch.order_ref, 80);
  if (patch.tracking) sets.tracking = clip(patch.tracking, 80);
  let status = p.status;
  // só o Pix direto (a pessoa paga) e a entrega mudam por aqui; dinheiro que passa pelo Asaas só muda pelo servidor
  if (patch.status === "paid" && p.method === "pix" && p.status === "awaiting_person") status = "paid";
  if (patch.status === "delivered" && p.status === "paid") status = "delivered";
  if (patch.status === "canceled" && ["awaiting_confirm", "awaiting_person"].includes(p.status)) status = "canceled";
  return setStatus(p.id, status, { ...sets, ...(status === "paid" && p.status !== "paid" ? { paid_at: new Date().toISOString() } : {}) });
}

export async function listPurchases(userId: string, limit = 50) {
  return many(
    `SELECT id, store, title, url, method, store_cents, fee_cents, total_cents, status, order_ref, tracking, error, invoice_url, created_at, paid_at
       FROM purchases WHERE user_id = $1 AND status <> 'awaiting_confirm' ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
}

export async function walletStatement(userId: string, limit = 30) {
  return many("SELECT kind, delta_cents, note, created_at FROM shop_ledger WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2", [userId, limit]);
}

/** Resumo para o dono: o que passou pelo Asaas no mês, taxas, saldo guardado e o que precisa de atenção. */
export async function purchasesOverview() {
  const month = await one(
    `SELECT COUNT(*) FILTER (WHERE status IN ('paid', 'delivered'))::int AS paid,
            COALESCE(SUM(total_cents) FILTER (WHERE status IN ('paid', 'delivered') AND method <> 'pix'), 0)::int AS through_asaas,
            COALESCE(SUM(fee_cents) FILTER (WHERE status IN ('paid', 'delivered')), 0)::int AS fees,
            COUNT(*) FILTER (WHERE status IN ('failed', 'refunded'))::int AS failed
       FROM purchases WHERE created_at > date_trunc('month', now())`,
  );
  const wallets = await one("SELECT COALESCE(SUM(balance_cents), 0)::int AS balance, COALESCE(SUM(held_cents), 0)::int AS held FROM shop_wallets");
  const recent = await many(
    `SELECT p.id, p.store, p.title, p.method, p.total_cents, p.fee_cents, p.status, p.error, p.created_at, COALESCE(u.full_name, u.name, '+' || u.phone) AS person
       FROM purchases p JOIN users u ON u.id = p.user_id WHERE p.status <> 'awaiting_confirm' ORDER BY p.created_at DESC LIMIT 30`,
  );
  return { month, wallets, recent };
}
