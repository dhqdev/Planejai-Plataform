import { config } from "./config.js";
import { many, one, query } from "./db/pool.js";
import { brl, parseAmount } from "./agent/tools/finance.js";
import { dueDateIn, todayIn } from "./bills.js";

/**
 * Cartões de crédito e faturas. O cartão guarda só apelido, banco/bandeira, final de 4 dígitos, limite, dia de
 * fechamento e de vencimento (nunca número, CVV ou validade). Cada compra no cartão é um lançamento normal com
 * `card_id` e `invoice_month` (AAAA-MM do vencimento da fatura em que cai); parcelado = uma linha por parcela,
 * cada uma na fatura do seu mês. Marcar a fatura como paga não lança gasto de novo: as compras já estão lá.
 */

export interface Card {
  id: string;
  user_id: string;
  name: string;
  brand: string | null;
  last4: string | null;
  limit_amount: number | null;
  closing_day: number;
  due_day: number;
  color: string;
  remind_days_before: number;
  active: boolean;
  last_reminded_on: string | null;
}

export type InvoiceStatus = "aberta" | "futura" | "fechada" | "atrasada" | "paga" | "zerada";

export const CARD_COLORS = ["preto", "grafite", "prata", "roxo", "azul", "verde", "laranja", "vinho"];
const DAY = 86_400_000;
const cents = (n: number) => Math.round(n * 100) / 100;

/** Soma meses a um AAAA-MM. */
export function addMonths(month: string, n: number) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

/** Mesma data N meses depois sem estourar o mês (31/01 + 1 = 28/02, não 03/03). */
export function shiftDate(d: Date, n: number) {
  if (!n) return new Date(d);
  const out = new Date(d);
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + n);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

type Cycle = Pick<Card, "closing_day" | "due_day">;

/** Fechamento e vencimento da fatura que vence em `month`. Vencimento antes do fechamento = fecha no mês anterior. */
export function invoiceDates(card: Cycle, month: string) {
  const closeMonth = card.due_day > card.closing_day ? month : addMonths(month, -1);
  return { closing: dueDateIn(closeMonth, card.closing_day), due: dueDateIn(month, card.due_day) };
}

/** Fatura (mês do vencimento) de uma compra feita em `date` (AAAA-MM-DD local). No dia do fechamento já cai na próxima. */
export function invoiceMonthFor(card: Cycle, date: string) {
  const m = date.slice(0, 7);
  const closeMonth = date < dueDateIn(m, card.closing_day) ? m : addMonths(m, 1);
  return card.due_day > card.closing_day ? closeMonth : addMonths(closeMonth, 1);
}

/** Próxima fatura a vencer (vencimento hoje ou depois). */
export function nextDueMonth(card: Cycle, today: string) {
  const m = today.slice(0, 7);
  for (const k of [-1, 0, 1, 2]) {
    const mm = addMonths(m, k);
    if (invoiceDates(card, mm).due >= today) return mm;
  }
  return addMonths(m, 1);
}

export function invoiceStatus(card: Cycle, month: string, today: string, total: number, paid: boolean): InvoiceStatus {
  if (paid) return "paga";
  const { closing, due } = invoiceDates(card, month);
  if (total <= 0 && today >= closing) return "zerada";
  if (today > due) return "atrasada";
  if (today >= closing) return "fechada";
  return month > invoiceMonthFor(card, today) ? "futura" : "aberta";
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);
const shortDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export const monthName = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]}/${m.slice(0, 4)}`;

/** Data local (AAAA-MM-DD) de um instante. */
export const localDate = (d: Date, tz: string) => todayIn(tz, d);

// ---------- cadastro ----------

export interface CardInput {
  name?: string;
  brand?: string | null;
  last4?: string | null;
  limit?: number | string | null;
  closing_day?: number;
  due_day?: number;
  color?: string;
  remind_days_before?: number;
}

function clean(input: CardInput) {
  const out: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const n = String(input.name).trim().slice(0, 40);
    if (!n) throw new Error("Dê um apelido para o cartão (ex.: Nubank)");
    out.name = n;
  }
  if (input.brand !== undefined) out.brand = input.brand ? String(input.brand).trim().slice(0, 30) || null : null;
  if (input.last4 !== undefined) {
    const digits = String(input.last4 ?? "").replace(/\D/g, "");
    // número inteiro do cartão nunca é guardado: aceita só o final
    if (digits.length > 4) throw new Error("Guardo só os 4 últimos dígitos, nunca o número inteiro do cartão");
    if (digits && digits.length !== 4) throw new Error("O final do cartão tem 4 dígitos");
    out.last4 = digits || null;
  }
  if (input.limit !== undefined) out.limit_amount = input.limit === null || input.limit === "" ? null : parseAmount(input.limit);
  for (const k of ["closing_day", "due_day"] as const) {
    if (input[k] === undefined) continue;
    const d = Math.floor(Number(input[k]));
    if (!(d >= 1 && d <= 31)) throw new Error(k === "closing_day" ? "Dia do fechamento entre 1 e 31" : "Dia do vencimento entre 1 e 31");
    out[k] = d;
  }
  if (input.color !== undefined) out.color = CARD_COLORS.includes(String(input.color)) ? input.color : "preto";
  if (input.remind_days_before !== undefined) out.remind_days_before = Math.max(0, Math.min(10, Math.floor(Number(input.remind_days_before) || 0)));
  return out;
}

export async function createCard(userId: string, input: CardInput) {
  const v = clean(input);
  if (!v.name) throw new Error("Dê um apelido para o cartão (ex.: Nubank)");
  if (!v.closing_day || !v.due_day) throw new Error("Preciso do dia em que a fatura fecha e do dia em que vence");
  const n = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM cards WHERE user_id = $1 AND active", [userId]);
  if ((n?.n ?? 0) >= 20) throw new Error("Limite de 20 cartões");
  return one<Card>(
    `INSERT INTO cards (user_id, name, brand, last4, limit_amount, closing_day, due_day, color, remind_days_before)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [userId, v.name, v.brand ?? null, v.last4 ?? null, v.limit_amount ?? null, v.closing_day, v.due_day, v.color ?? "preto", v.remind_days_before ?? 3],
  );
}

export async function updateCard(userId: string, id: string, input: CardInput) {
  const v = clean(input);
  const cols = Object.keys(v);
  if (!cols.length) throw new Error("Nada para mudar");
  const card = await one<Card>(
    `UPDATE cards SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(", ")} WHERE id = $1 AND user_id = $2 AND active RETURNING *`,
    [id, userId, ...Object.values(v)],
  );
  // mudou o ciclo: as compras das faturas ainda não pagas mudam de fatura
  if (card && ("closing_day" in v || "due_day" in v)) await placeOnCard(userId, card, null);
  return card;
}

/** Para de acompanhar o cartão; as compras ficam nos lançamentos (com o nome dele). */
export async function deleteCard(userId: string, id: string) {
  const r = await query("UPDATE cards SET active = false WHERE id = $1 AND user_id = $2 AND active", [id, userId]);
  return (r.rowCount ?? 0) > 0;
}

export async function getCard(userId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  return one<Card>("SELECT * FROM cards WHERE id = $1 AND user_id = $2 AND active", [id, userId]);
}

const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Acha o cartão pelo que a pessoa disse: apelido, banco/bandeira ou final ("final 1234"). Só um cartão + "no cartão" = ele. */
export async function findCard(userId: string, q: string) {
  const all = await many<Card>("SELECT * FROM cards WHERE user_id = $1 AND active ORDER BY created_at", [userId]);
  const s = strip(q).replace(/^(no|na|o|a|meu|minha)\s+/, "").replace(/^(cartao|cartao de credito|credito)\s+(do|da|de)?\s*/, "");
  if (!s || /^(cartao|cartao de credito|credito)$/.test(s)) return all.length === 1 ? all : [];
  const digits = s.match(/\b(\d{4})\b/)?.[1];
  if (digits) {
    const byEnd = all.filter((c) => c.last4 === digits);
    if (byEnd.length) return byEnd;
  }
  const exact = all.filter((c) => strip(c.name) === s || (c.brand && strip(c.brand) === s));
  if (exact.length) return exact;
  return all.filter((c) => strip(c.name).includes(s) || s.includes(strip(c.name)) || (c.brand && (strip(c.brand).includes(s) || s.includes(strip(c.brand)))));
}

/** Nome do banco do jeito que aparece em fatura, Pix e conta fixa ("Nu Pagamentos" = Nubank). */
const BANKS: [RegExp, string][] = [
  [/\bnu ?(pagamentos|financeira|bank|invest)\b|\bnubank\b|\broxinho\b/, "nubank"],
  [/\bita[uú]|itaucard|unibanco|\biti\b/, "itau"],
  [/bradesco|bradescard/, "bradesco"],
  [/santander/, "santander"],
  [/banco inter\b|\binter\b/, "inter"],
  [/\bc6\b/, "c6"],
  [/\bcaixa\b/, "caixa"],
  [/banco do brasil|ourocard|\bbb\b/, "bb"],
  [/mercado ?pago/, "mercadopago"],
  [/picpay/, "picpay"],
  [/\bneon\b/, "neon"],
  [/\bwill ?bank\b/, "will"],
  [/\bxp\b/, "xp"],
  [/\bbtg\b/, "btg"],
  [/porto ?(seguro|bank)/, "porto"],
  [/sicredi/, "sicredi"],
  [/sicoob/, "sicoob"],
  [/banco pan\b|\bpan\b/, "pan"],
];
const bankOf = (s: string) => BANKS.find(([re]) => re.test(s))?.[1] ?? null;

const CUE = /\b(fatura|cartao|credito)\b/;
const STOP = new Set(["o", "a", "do", "da", "de", "meu", "minha", "conta", "pagamento", "pagamentos", "banco", "sa", "s", "ltda", "ip", "instituicao", "me", "ao"]);
const onlyName = (rest: string) => rest.split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)).length === 0;
const esc = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * O texto (conta fixa, comprovante) é a fatura desse cartão? Precisa do nome/banco do cartão em palavra inteira
 * ("Inter" não casa com "Internet") e falar em fatura/cartão, ou não ter mais nada além do nome
 * ("Financiamento Caixa" não é a fatura do cartão Caixa; "Nu Pagamentos SA" é a do Nubank).
 */
export function looksLikeInvoiceOf(c: Pick<Card, "name" | "brand" | "last4">, text: string) {
  const s = strip(text ?? "");
  if (!s) return false;
  const cue = CUE.test(s);
  const keys = [c.name, c.brand].filter(Boolean).map((k) => strip(k!));
  for (const k of keys) {
    const re = new RegExp(`(^|[^a-z0-9])${esc(k)}($|[^a-z0-9])`);
    if (k.length >= 2 && re.test(s) && (cue || onlyName(s.replace(re, " ")))) return true;
  }
  if (c.last4 && s.includes(c.last4) && cue) return true;
  const bank = bankOf(s);
  if (bank && keys.some((k) => bankOf(k) === bank)) {
    const re = BANKS.find(([, b]) => b === bank)![0];
    return cue || onlyName(s.replace(new RegExp(re.source, "g"), " "));
  }
  return false;
}

/**
 * Cartões (com compras lançadas) cuja fatura um texto parece ser: "Fatura Nubank", conta fixa "Cartão Itaú",
 * Pix para "Nu Pagamentos". Serve para não lançar de novo como gasto o que já está nas compras do cartão.
 * Texto genérico ("fatura do cartão") só vale quando ela tem um cartão só.
 */
export async function cardsPaidBy(userId: string, text: string) {
  const cards = await many<Card>(
    "SELECT c.* FROM cards c WHERE c.user_id = $1 AND c.active AND EXISTS (SELECT 1 FROM transactions t WHERE t.card_id = c.id) ORDER BY c.created_at",
    [userId],
  );
  if (!cards.length) return [];
  const s = strip(text ?? "");
  if (!s) return [];
  const hits = cards.filter((c) => looksLikeInvoiceOf(c, s));
  if (hits.length) return hits;
  // genérico ("fatura do cartão") só com um cartão; "fatura da internet" não
  return cards.length === 1 && CUE.test(s) && onlyName(s.replace(/\b(fatura|cartao|credito)\b/g, " ")) ? cards : [];
}

/** Resolve o cartão para uma ferramenta: devolve o cartão ou um erro pronto para o modelo. */
export async function resolveCard(userId: string, q: string): Promise<Card | { error: string }> {
  const found = await findCard(userId, q);
  if (found.length === 1) return found[0]!;
  const all = await many<Card>("SELECT name, last4 FROM cards WHERE user_id = $1 AND active ORDER BY created_at", [userId]);
  const names = all.map((c) => `${c.name}${c.last4 ? ` (final ${c.last4})` : ""}`).join(", ");
  if (found.length > 1) return { error: `Mais de um cartão bate com "${q}": ${found.map((c) => c.name).join(", ")}. Pergunte qual.` };
  return {
    error: all.length
      ? `Não achei o cartão "${q}". Cartões dela: ${names}. Pergunte qual é, ou se quer cadastrar esse (card_save com apelido, dia do fechamento e do vencimento).`
      : `Ela ainda não tem cartão cadastrado. Pergunte o apelido, o dia em que a fatura fecha e o dia em que vence (e o limite, se quiser) e use card_save; depois lance.`,
  };
}

/**
 * Recalcula em qual fatura cai cada compra do cartão (cadastro novo de compra, troca de cartão ou de ciclo).
 * `ids` null = todas as compras dele em faturas ainda não pagas. Parcelas seguem a data da 1ª parcela.
 */
export async function placeOnCard(userId: string, card: Card, ids: string[] | null, tz = config.DEFAULT_TIMEZONE) {
  const rows = await many<{ id: string; occurred_at: Date; installment: number | null; purchase_id: string | null; first_at: Date | null }>(
    `SELECT t.id, t.occurred_at, t.installment, t.purchase_id,
            (SELECT MIN(f.occurred_at) FROM transactions f WHERE f.purchase_id = t.purchase_id AND f.user_id = t.user_id) AS first_at
       FROM transactions t
      WHERE t.user_id = $1 AND t.card_id = $2 AND ($3::uuid[] IS NULL OR t.id = ANY($3::uuid[]))
        AND ($3::uuid[] IS NOT NULL OR NOT EXISTS (SELECT 1 FROM card_invoices ci WHERE ci.card_id = t.card_id AND ci.month = t.invoice_month))`,
    [userId, card.id, ids],
  );
  for (const r of rows) {
    const base = r.purchase_id && r.first_at ? r.first_at : r.occurred_at;
    const month = addMonths(invoiceMonthFor(card, localDate(new Date(base), tz)), r.purchase_id && r.installment ? r.installment - 1 : 0);
    await query("UPDATE transactions SET invoice_month = $2 WHERE id = $1", [r.id, month]);
  }
}

// ---------- faturas ----------

export interface Invoice {
  month: string;
  total: number;
  count: number;
  closing: string;
  due: string;
  status: InvoiceStatus;
  paid_amount: number | null;
}

async function invoiceRows(cardIds: string[]) {
  if (!cardIds.length) return { totals: new Map<string, Map<string, { total: number; count: number }>>(), paid: new Map<string, Map<string, number | null>>() };
  const sums = await many<{ card_id: string; month: string; total: number; count: number }>(
    `SELECT card_id, invoice_month AS month, SUM(CASE WHEN kind = 'expense' THEN amount ELSE -amount END) AS total, COUNT(*)::int AS count
       FROM transactions WHERE card_id = ANY($1::uuid[]) AND invoice_month IS NOT NULL GROUP BY 1, 2`,
    [cardIds],
  );
  const paidRows = await many<{ card_id: string; month: string; paid_amount: number | null }>("SELECT card_id, month, paid_amount FROM card_invoices WHERE card_id = ANY($1::uuid[])", [cardIds]);
  const totals = new Map<string, Map<string, { total: number; count: number }>>();
  for (const r of sums) {
    if (!totals.has(r.card_id)) totals.set(r.card_id, new Map());
    totals.get(r.card_id)!.set(r.month, { total: cents(Number(r.total)), count: r.count });
  }
  const paid = new Map<string, Map<string, number | null>>();
  for (const r of paidRows) {
    if (!paid.has(r.card_id)) paid.set(r.card_id, new Map());
    paid.get(r.card_id)!.set(r.month, r.paid_amount);
  }
  return { totals, paid };
}

function makeInvoice(card: Card, month: string, today: string, t?: { total: number; count: number }, paid?: Map<string, number | null>): Invoice {
  const total = t?.total ?? 0;
  const isPaid = paid?.has(month) ?? false;
  return { month, total, count: t?.count ?? 0, ...invoiceDates(card, month), status: invoiceStatus(card, month, today, total, isPaid), paid_amount: isPaid ? (paid!.get(month) ?? null) : null };
}

/** Cartões com limite usado, fatura aberta, próxima a vencer, linha do tempo mês a mês e parcelamentos em andamento. */
export async function listCards(userId: string, tz = config.DEFAULT_TIMEZONE) {
  const cards = await many<Card>("SELECT * FROM cards WHERE user_id = $1 AND active ORDER BY created_at", [userId]);
  const today = todayIn(tz);
  const { totals, paid } = await invoiceRows(cards.map((c) => c.id));
  const plans = cards.length
    ? await many<{ card_id: string; purchase_id: string; description: string | null; merchant: string | null; category: string; installments: number; parts: { m: string; a: number }[] }>(
        `SELECT card_id, purchase_id, MIN(description) AS description, MIN(merchant) AS merchant, MIN(category) AS category, MAX(installments)::int AS installments,
                json_agg(json_build_object('m', invoice_month, 'a', amount) ORDER BY invoice_month) AS parts
           FROM transactions WHERE card_id = ANY($1::uuid[]) AND purchase_id IS NOT NULL AND installments > 1 AND kind = 'expense'
          GROUP BY card_id, purchase_id`,
        [cards.map((c) => c.id)],
      )
    : [];
  return cards.map((c) => {
    const t = totals.get(c.id) ?? new Map();
    const p = paid.get(c.id) ?? new Map();
    const open = invoiceMonthFor(c, today);
    const next = nextDueMonth(c, today);
    let used = 0;
    for (const [m, v] of t) if (!p.has(m) && v.total > 0) used += v.total;
    used = cents(used);
    const months = [...t.keys()].sort();
    const last = months.length ? months[months.length - 1]! : open;
    const from = addMonths(open, -3);
    const to = last > addMonths(open, 2) ? (last > addMonths(open, 23) ? addMonths(open, 23) : last) : addMonths(open, 2);
    const invoices: Invoice[] = [];
    for (let m = from; m <= to; m = addMonths(m, 1)) invoices.push(makeInvoice(c, m, today, t.get(m), p));
    const installments = plans
      .filter((x) => x.card_id === c.id)
      .map((x) => {
        const left = x.parts.filter((pt) => !p.has(pt.m));
        return {
          purchase_id: x.purchase_id,
          description: (x.description ?? x.merchant ?? x.category).replace(/\s*\(\d+\/\d+\)$/, ""),
          installments: x.installments,
          part: Number(x.parts[x.parts.length - 1]?.a ?? 0),
          paid: x.parts.length - left.length,
          left: left.length,
          left_amount: cents(left.reduce((a, pt) => a + Number(pt.a), 0)),
          last_month: x.parts[x.parts.length - 1]?.m ?? null,
        };
      })
      .filter((x) => x.left > 0)
      .sort((a, b) => (a.last_month ?? "").localeCompare(b.last_month ?? ""));
    return {
      id: c.id,
      name: c.name,
      brand: c.brand,
      last4: c.last4,
      limit: c.limit_amount,
      closing_day: c.closing_day,
      due_day: c.due_day,
      color: c.color,
      remind_days_before: c.remind_days_before,
      used,
      available: c.limit_amount != null ? cents(c.limit_amount - used) : null,
      open: makeInvoice(c, open, today, t.get(open), p),
      next: makeInvoice(c, next, today, t.get(next), p),
      invoices,
      installments,
    };
  });
}

export type CardSummary = Awaited<ReturnType<typeof listCards>>[number];

/** Compras de uma fatura. */
export async function invoiceItems(userId: string, card: Card, month: string, tz = config.DEFAULT_TIMEZONE) {
  const items = await many(
    `SELECT id, kind, amount, category, description, merchant, occurred_at, installment, installments, source
       FROM transactions WHERE user_id = $1 AND card_id = $2 AND invoice_month = $3 ORDER BY occurred_at DESC, created_at DESC LIMIT 400`,
    [userId, card.id, month],
  );
  const { totals, paid } = await invoiceRows([card.id]);
  return { invoice: makeInvoice(card, month, todayIn(tz), totals.get(card.id)?.get(month), paid.get(card.id)), items };
}

/** Fatura que "paguei a fatura" quer dizer: a mais antiga fechada e não paga; senão a próxima a vencer. */
export async function defaultPayMonth(card: Card, tz = config.DEFAULT_TIMEZONE) {
  const today = todayIn(tz);
  const { totals, paid } = await invoiceRows([card.id]);
  const t = totals.get(card.id) ?? new Map();
  const p = paid.get(card.id) ?? new Map();
  const pending = [...t.entries()].filter(([m, v]) => v.total > 0 && !p.has(m) && invoiceDates(card, m).closing <= today).map(([m]) => m).sort();
  return pending[0] ?? nextDueMonth(card, today);
}

export async function payInvoice(userId: string, card: Card, month: string, amount?: number | string | null) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Mês da fatura em AAAA-MM");
  const value = amount != null && amount !== "" ? parseAmount(amount) : null;
  const r = await query("INSERT INTO card_invoices (card_id, month, paid_amount) VALUES ($1, $2, $3) ON CONFLICT (card_id, month) DO NOTHING", [card.id, month, value]);
  const { invoice } = await invoiceItems(userId, card, month);
  return { already: (r.rowCount ?? 0) === 0, invoice };
}

export async function unpayInvoice(card: Card, month: string) {
  const r = await query("DELETE FROM card_invoices WHERE card_id = $1 AND month = $2", [card.id, month]);
  return (r.rowCount ?? 0) > 0;
}

// ---------- lembretes ----------

/** Lembretes do dia de um cartão (puro, fácil de testar): fechou hoje, vence em N dias, vence hoje, venceu ontem. */
export function cardReminderLines(card: Card, today: string, totals: Map<string, { total: number }>, paid: Set<string>) {
  if (card.last_reminded_on && String(card.last_reminded_on).slice(0, 10) === today) return [];
  const lines: string[] = [];
  const m = today.slice(0, 7);
  for (const k of [-1, 0, 1, 2]) {
    const month = addMonths(m, k);
    const total = totals.get(month)?.total ?? 0;
    if (total <= 0 || paid.has(month)) continue;
    const { closing, due } = invoiceDates(card, month);
    const days = daysBetween(today, due);
    const value = brl(total);
    if (closing === today) lines.push(`A fatura do ${card.name} fechou hoje em ${value} e vence dia ${shortDate(due)}.`);
    else if (days === 0) lines.push(`Hoje vence a fatura do ${card.name}: ${value}.`);
    else if (days > 0 && days === card.remind_days_before) lines.push(`${days === 1 ? "Amanhã" : `Dia ${shortDate(due)}`} vence a fatura do ${card.name}: ${value}.`);
    else if (days === -1) lines.push(`A fatura do ${card.name} (${value}) venceu ontem e ainda não marquei como paga.`);
  }
  return lines;
}

/** Rodada diária (worker, junto das contas fixas): uma mensagem por pessoa com as faturas do dia. */
export async function remindCards(log?: { info: (...a: any[]) => void; error: (...a: any[]) => void }) {
  const cards = await many<Card & { timezone: string | null }>(
    `SELECT c.*, u.timezone FROM cards c JOIN users u ON u.id = c.user_id WHERE c.active AND u.status = 'active' ORDER BY c.user_id, c.created_at`,
  );
  if (!cards.length) return 0;
  const { totals, paid } = await invoiceRows(cards.map((c) => c.id));
  const byUser = new Map<string, (Card & { timezone: string | null })[]>();
  for (const c of cards) byUser.set(c.user_id, [...(byUser.get(c.user_id) ?? []), c]);
  const { notifyUser } = await import("./social.js");
  let sent = 0;
  for (const [userId, list] of byUser) {
    const today = todayIn(list[0]!.timezone ?? config.DEFAULT_TIMEZONE);
    const lines: string[] = [];
    const ids: string[] = [];
    for (const c of list) {
      const l = cardReminderLines(c, today, totals.get(c.id) ?? new Map(), new Set((paid.get(c.id) ?? new Map()).keys()));
      if (!l.length) continue;
      lines.push(...l);
      ids.push(c.id);
    }
    if (!lines.length) continue;
    const text = `${lines.join("\n")}\n\nQuando pagar, me fala "paguei a fatura" que eu marco aqui.`;
    try {
      await notifyUser(userId, text);
      await query("UPDATE cards SET last_reminded_on = $2 WHERE id = ANY($1::uuid[])", [ids, today]);
      sent++;
    } catch (err) {
      log?.error({ err, userId }, "lembrete de fatura falhou");
    }
  }
  if (sent) log?.info({ sent }, "lembretes de fatura enviados");
  return sent;
}

