import { asaas } from "./billing.js";
import { tellPerson } from "./credits.js";
import { decryptJson, encryptJson } from "./crypto.js";
import { many, one, query } from "./db/pool.js";
import { getCredentials } from "./integrations/registry.js";
import { notify } from "./notifications.js";
import { parsePixCode } from "./pixcode.js";
import { type AgentSettings, getSettings } from "./settings.js";
import { STORES, storeDefFor, storeOfFor } from "./stores.js";

/**
 * Compras pelo assistente, só com Pix direto. O agente acha o produto, entra na conta da pessoa na loja (login que ela
 * fez pelo painel), monta o carrinho e escolhe Pix no checkout. O código Pix da loja é a fonte do valor: o servidor lê
 * o total dele e pede o "sim" com o valor exato. Depois do sim o código vai para a pessoa, que paga do banco dela.
 * Dinheiro nunca passa pelo Planejai e não há taxa. Nenhum valor vem do modelo.
 */

/** Versão dos Termos de compra: mudou o texto, sobe a data e todo mundo aceita de novo. */
export const TERMS_VERSION = "2026-10-09.2";

export { STORES, storeOf } from "./stores.js";

export const brl = (cents: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100).replace(/ /g, " ");

const clip = (s: unknown, n = 120) => String(s ?? "").trim().slice(0, n);

// ---------------- Endereço de entrega e termos ----------------

export interface Address {
  cep: string;
  street: string;
  number: string;
  complement?: string;
  district: string;
  city: string;
  state: string;
}

/** Confere e limpa o endereço que veio do formulário. Erro com texto pronto para a tela. */
export function cleanAddress(a: any): Address {
  const address = {
    cep: String(a?.cep ?? "").replace(/\D/g, ""),
    street: clip(a?.street),
    number: clip(a?.number, 20),
    complement: clip(a?.complement, 60) || undefined,
    district: clip(a?.district, 80),
    city: clip(a?.city, 80),
    state: clip(a?.state, 2).toUpperCase(),
  };
  if (address.cep.length !== 8) throw new Error("CEP precisa ter 8 números.");
  if (!address.street || !address.number || !address.district || !address.city || !/^[A-Z]{2}$/.test(address.state)) {
    throw new Error("Complete o endereço de entrega (rua, número, bairro, cidade e UF).");
  }
  return address;
}

interface ProfileRow {
  user_id: string;
  data: string | null;
  terms_version: string | null;
  terms_accepted_at: string | null;
}

async function profileRow(userId: string) {
  return (await one<ProfileRow>("SELECT user_id, data, terms_version, terms_accepted_at FROM buyer_profiles WHERE user_id = $1", [userId])) ?? null;
}

function addressOf(row: ProfileRow | null): Address | null {
  if (!row?.data) return null;
  try {
    return decryptJson<{ address?: Address }>(row.data).address ?? null;
  } catch {
    return null;
  }
}

const termsOk = (row: ProfileRow | null) => row?.terms_version === TERMS_VERSION && Boolean(row.terms_accepted_at);

export async function buyerProfile(userId: string) {
  const row = await profileRow(userId);
  return {
    address: addressOf(row),
    terms: { version: TERMS_VERSION, accepted: termsOk(row), accepted_at: row?.terms_accepted_at ?? null },
  };
}

/** Endereço de entrega (criptografado): o agente confere se o checkout vai para ele. */
export async function saveBuyerAddress(userId: string, raw: unknown) {
  const address = cleanAddress(raw);
  await query(
    `INSERT INTO buyer_profiles (user_id, data, city) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET data = $2, city = $3, updated_at = now()`,
    [userId, encryptJson({ address }), `${address.city}/${address.state}`],
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

// ---------------- Regras do dono ----------------

export function purchaseRules(s: AgentSettings) {
  return {
    enabled: Boolean(s.purchasesEnabled),
    maxCents: Number(s.purchaseMaxCents ?? 0),
    monthMaxCents: Number(s.purchaseMonthMaxCents ?? 0),
    termsVersion: TERMS_VERSION,
    stores: Object.entries(STORES).map(([id, st]) => ({ id, name: st.name })),
  };
}

/** Quanto a pessoa já comprou nos últimos 30 dias, contando só o que seguiu depois do sim. */
export async function spentLast30(userId: string) {
  const r = await one<{ v: number }>(
    `SELECT COALESCE(SUM(store_cents), 0)::int AS v FROM purchases
      WHERE user_id = $1 AND created_at > now() - interval '30 days' AND status IN ('awaiting_person', 'paid', 'delivered')`,
    [userId],
  );
  return r?.v ?? 0;
}

// ---------------- Código Pix da loja ----------------

/**
 * Lê o código Pix da loja e acha o valor. Vale o valor escrito no código; Pix dinâmico sem valor escrito precisa do
 * Asaas conectado para ler a cobrança (só leitura: nada é pago por aqui).
 */
export async function checkStorePix(raw: string): Promise<{ payload: string; cents: number; receiver: string | null }> {
  const code = parsePixCode(raw);
  if (!code) throw new Error("O código Pix está incompleto ou não é um Pix copia e cola. Copie de novo o código inteiro do checkout.");
  if (code.cents) return { payload: code.payload, cents: code.cents, receiver: code.receiver };
  const connected = Boolean((await getCredentials("asaas").catch(() => null))?.api_key);
  if (!connected) throw new Error("Esse Pix não traz o valor escrito no código, então não dá para conferir o total. Mande o total que aparece no checkout e o link para a pessoa conferir.");
  const dec: any = await asaas("POST", "/pix/qrCodes/decode", { payload: code.payload });
  const cents = Math.round(Number(dec?.totalValue ?? dec?.value ?? 0) * 100);
  if (!(cents > 0)) throw new Error("Não deu para ler o valor desse Pix. Gere o código de novo no checkout.");
  return { payload: code.payload, cents, receiver: dec?.receiver?.name ?? code.receiver };
}

// ---------------- Compra ----------------

export interface PurchaseRow {
  id: string;
  user_id: string;
  store: string;
  title: string;
  url: string | null;
  store_cents: number;
  total_cents: number;
  store_pix: string;
  store_receiver: string | null;
  status: string;
  order_ref: string | null;
  tracking: string | null;
  error: string | null;
  created_at: string;
}

export const STATUS_TXT: Record<string, string> = {
  awaiting_confirm: "esperando o sim",
  awaiting_person: "esperando ela pagar o Pix",
  paid: "pago na loja",
  delivered: "entregue",
  canceled: "cancelado",
};

/** Pode comprar agora? Devolve o motivo quando não pode. */
async function blockedReason(userId: string, cents: number, s: AgentSettings, row: ProfileRow | null) {
  const rules = purchaseRules(s);
  if (!rules.enabled) return "Compras pelo assistente ainda não estão ligadas.";
  if (!termsOk(row)) return "A pessoa ainda não aceitou os Termos de compra: peça para ela abrir Compras no painel e aceitar.";
  if (cents > rules.maxCents) return `Passa do limite por compra (${brl(rules.maxCents)}).`;
  if ((await spentLast30(userId)) + cents > rules.monthMaxCents) return `Passa do limite de ${brl(rules.monthMaxCents)} em 30 dias.`;
  return null;
}

/**
 * Primeiro passo (o agente chama com o Pix do checkout): confere tudo e guarda a compra esperando o "sim".
 * Devolve o resumo exato que vai na pergunta.
 */
export async function preparePurchase(userId: string, input: { title: string; url?: string; store?: string; pix_code: string }) {
  const s = await getSettings();
  const title = clip(input.title, 140);
  if (!title) throw new Error("Diga o que está sendo comprado (title).");
  const store = (await storeOfFor(userId, input.url)) ?? (input.store && (await storeDefFor(userId, input.store)) ? input.store : null) ?? clip(input.store, 40).toLowerCase();
  if (!store) throw new Error("Qual loja? Mande a url do produto.");
  const row = await profileRow(userId);
  const early = await blockedReason(userId, 0, s, row);
  if (early) throw new Error(early);
  const pix = await checkStorePix(input.pix_code);
  const why = await blockedReason(userId, pix.cents, s, row);
  if (why) throw new Error(why);
  // o mesmo pedido de novo substitui o anterior
  await query("UPDATE purchases SET status = 'canceled', updated_at = now() WHERE user_id = $1 AND status = 'awaiting_confirm'", [userId]);
  const p = await one<PurchaseRow>(
    `INSERT INTO purchases (user_id, store, title, url, method, store_cents, fee_cents, total_cents, store_pix, store_receiver)
     VALUES ($1, $2, $3, $4, 'pix', $5, 0, $5, $6, $7) RETURNING *`,
    [userId, store, title, input.url ? clip(input.url, 500) : null, pix.cents, pix.payload, pix.receiver],
  );
  return { purchase: p!, summary: purchaseSummary(p!, (await storeDefFor(userId, store))?.name) };
}

export function purchaseSummary(p: PurchaseRow, storeName?: string) {
  const who = p.store_receiver ? ` (Pix para ${p.store_receiver})` : "";
  return `comprar "${p.title}" no ${storeName ?? STORES[p.store]?.name ?? p.store} por ${brl(p.store_cents)}${who}, com o Pix da loja pago por ela no banco dela`;
}

/** A pessoa disse "sim" (conferido pelo servidor): manda o Pix da loja para ela pagar. */
export async function approvePurchase(userId: string, purchaseId: string): Promise<{ ok: boolean; say: string }> {
  const gone = { ok: false, say: "Esse pedido de compra já foi resolvido ou expirou. Se ainda quer, é só pedir de novo." };
  const waiting = await one<PurchaseRow>("SELECT * FROM purchases WHERE id::text = $1 AND user_id = $2 AND status = 'awaiting_confirm'", [purchaseId, userId]);
  if (!waiting) return gone;
  // as regras valem de novo na hora do sim (o dono pode ter mudado)
  const why = await blockedReason(userId, waiting.store_cents, await getSettings(), await profileRow(userId));
  if (why) {
    await query("UPDATE purchases SET status = 'canceled', error = $2, updated_at = now() WHERE id = $1 AND status = 'awaiting_confirm'", [waiting.id, why]);
    return { ok: false, say: why };
  }
  // um "sim" só: duas execuções ao mesmo tempo, só uma passa daqui
  const p = await one<PurchaseRow>("UPDATE purchases SET status = 'awaiting_person', updated_at = now() WHERE id = $1 AND status = 'awaiting_confirm' RETURNING *", [waiting.id]);
  if (!p) return gone;
  // o código vai sozinho numa mensagem, para copiar sem nada em volta
  await tellPerson(userId, p.store_pix, "compras", "/compras");
  return { ok: true, say: `Mandei o código Pix (copia e cola) de ${brl(p.store_cents)}. Quando pagar no banco, o pedido segue na loja; me avise que eu anoto.` };
}

/** Pedido ou rastreio que o agente viu na loja; ou a pessoa disse que pagou, recebeu ou desistiu. */
export async function updatePurchase(userId: string, id: string, patch: { order_ref?: string; tracking?: string; status?: "paid" | "delivered" | "canceled" }) {
  const p = await one<PurchaseRow>("SELECT * FROM purchases WHERE id::text = $1 AND user_id = $2", [id, userId]);
  if (!p) throw new Error("Compra não encontrada.");
  let status = p.status;
  if (patch.status === "paid" && p.status === "awaiting_person") status = "paid";
  if (patch.status === "delivered" && ["paid", "awaiting_person"].includes(p.status)) status = "delivered";
  if (patch.status === "canceled" && ["awaiting_confirm", "awaiting_person"].includes(p.status)) status = "canceled";
  return one<PurchaseRow>(
    `UPDATE purchases SET status = $2, order_ref = COALESCE($3, order_ref), tracking = COALESCE($4, tracking),
            paid_at = CASE WHEN $2 IN ('paid', 'delivered') AND paid_at IS NULL THEN now() ELSE paid_at END, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [p.id, status, patch.order_ref ? clip(patch.order_ref, 80) : null, patch.tracking ? clip(patch.tracking, 80) : null],
  );
}

/** Rodada de poucos minutos: pedido sem "sim" há 30 minutos cai; Pix mandado e não pago em 2 dias vira cancelado. */
export async function checkOpenPurchases() {
  await query("UPDATE purchases SET status = 'canceled', updated_at = now() WHERE status = 'awaiting_confirm' AND created_at < now() - interval '30 minutes'");
  const stale = await many<PurchaseRow>(
    "UPDATE purchases SET status = 'canceled', error = 'Pix não pago a tempo', updated_at = now() WHERE status = 'awaiting_person' AND updated_at < now() - interval '2 days' RETURNING *",
  );
  for (const p of stale) await notify({ userId: p.user_id, kind: "compras", title: `Compra cancelada: ${p.title}`, body: "O Pix da loja não foi pago a tempo. Se ainda quiser, peça de novo.", link: "/compras" }).catch(() => {});
  return { canceled: stale.length };
}

export async function listPurchases(userId: string, limit = 50) {
  return many(
    `SELECT id, store, title, url, store_cents, status, order_ref, tracking, error, created_at, paid_at
       FROM purchases WHERE user_id = $1 AND status <> 'awaiting_confirm' ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
}

/** Resumo para o dono: quantas compras o assistente fechou no mês e o valor que foi para as lojas. */
export async function purchasesOverview() {
  return one(
    `SELECT COUNT(*) FILTER (WHERE status IN ('paid', 'delivered'))::int AS paid,
            COUNT(*) FILTER (WHERE status = 'awaiting_person')::int AS waiting,
            COALESCE(SUM(store_cents) FILTER (WHERE status IN ('paid', 'delivered')), 0)::int AS stores_cents,
            COUNT(DISTINCT user_id) FILTER (WHERE status <> 'awaiting_confirm')::int AS people
       FROM purchases WHERE created_at > date_trunc('month', now())`,
  );
}
