import { config } from "./config.js";
import { many, one, query } from "./db/pool.js";
import { brl, CATEGORIES, guessCategory, parseAmount } from "./agent/tools/finance.js";
import { emitEvent } from "./events.js";

/**
 * Contas fixas (vinham dos fluxos antigos "despesas/receitas fixas" e "parcela BCI" do n8n): aluguel, internet,
 * parcelas, salário. Todo dia de manhã o worker manda UMA mensagem por pessoa com o que vence (ou cai) e, se uma
 * despesa passou do dia sem "paguei", pergunta no dia seguinte. "Paguei" lança o valor no mês e marca o mês como pago.
 */

export interface Bill {
  id: string;
  user_id: string;
  kind: "expense" | "income";
  description: string;
  amount: string | null;
  category: string;
  due_day: number;
  remind_days_before: number;
  installments_left: number | null;
  active: boolean;
  last_paid_month: string | null;
  last_reminded_on: string | null;
}

const DAY = 86_400_000;

/** Hoje (AAAA-MM-DD) no fuso da pessoa. */
export function todayIn(tz: string, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Dia do vencimento num mês (dia 31 em fevereiro vira o último dia). */
export function dueDateIn(month: string, dueDay: number) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(Math.min(dueDay, last)).padStart(2, "0")}`;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);
const nextMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
};

/** Situação da conta hoje: paga no mês, vence em N dias, venceu há N dias. */
export function billStatus(b: Pick<Bill, "due_day" | "last_paid_month" | "kind">, today: string) {
  const month = today.slice(0, 7);
  const paid = b.last_paid_month === month;
  const due = dueDateIn(paid ? nextMonth(month) : month, b.due_day);
  const days = daysBetween(today, due);
  return { paid, due, days, late: !paid && days < 0 };
}

const shortDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const money = (b: Bill) => (b.amount != null ? ` (${brl(Number(b.amount))})` : "");

export async function listBills(userId: string, tz = config.DEFAULT_TIMEZONE) {
  const rows = await many<Bill>("SELECT * FROM bills WHERE user_id = $1 AND active ORDER BY due_day, description", [userId]);
  const today = todayIn(tz);
  return rows.map((b) => ({ ...b, amount: b.amount != null ? Number(b.amount) : null, status: billStatus(b, today) }));
}

export interface BillInput {
  description?: string;
  kind?: "expense" | "income";
  amount?: number | string | null;
  category?: string;
  due_day?: number;
  remind_days_before?: number;
  installments_left?: number | null;
}

function clean(input: BillInput) {
  const out: Record<string, unknown> = {};
  if (input.description !== undefined) {
    const d = String(input.description).trim().slice(0, 80);
    if (!d) throw new Error("Diga o nome da conta");
    out.description = d;
  }
  if (input.kind !== undefined) out.kind = input.kind === "income" ? "income" : "expense";
  if (input.amount !== undefined) out.amount = input.amount === null || input.amount === "" ? null : parseAmount(input.amount) || null;
  if (input.category !== undefined) out.category = CATEGORIES.includes(String(input.category)) ? input.category : "Contas";
  if (input.due_day !== undefined) {
    const d = Math.floor(Number(input.due_day));
    if (!(d >= 1 && d <= 31)) throw new Error("Dia do vencimento entre 1 e 31");
    out.due_day = d;
  }
  if (input.remind_days_before !== undefined) out.remind_days_before = Math.max(0, Math.min(10, Math.floor(Number(input.remind_days_before) || 0)));
  if (input.installments_left !== undefined) out.installments_left = input.installments_left == null ? null : Math.max(1, Math.floor(Number(input.installments_left)));
  return out;
}

export async function createBill(userId: string, input: BillInput) {
  const v = clean(input);
  if (!v.description || !v.due_day) throw new Error("Precisa do nome e do dia do vencimento");
  const kind = (v.kind as string) ?? "expense";
  const category = (v.category as string) ?? guessCategory(String(v.description)) ?? (kind === "income" ? "Salário" : "Contas");
  const n = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM bills WHERE user_id = $1 AND active", [userId]);
  if ((n?.n ?? 0) >= 60) throw new Error("Limite de 60 contas fixas");
  return one<Bill>(
    `INSERT INTO bills (user_id, kind, description, amount, category, due_day, remind_days_before, installments_left)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [userId, kind, v.description, v.amount ?? null, category, v.due_day, v.remind_days_before ?? 1, v.installments_left ?? null],
  );
}

export async function updateBill(userId: string, id: string, input: BillInput) {
  const v = clean(input);
  const cols = Object.keys(v);
  if (!cols.length) throw new Error("Nada para mudar");
  return one<Bill>(
    `UPDATE bills SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(", ")} WHERE id = $1 AND user_id = $2 AND active RETURNING *`,
    [id, userId, ...Object.values(v)],
  );
}

export async function deleteBill(userId: string, id: string) {
  const r = await query("UPDATE bills SET active = false WHERE id = $1 AND user_id = $2 AND active", [id, userId]);
  return (r.rowCount ?? 0) > 0;
}

/** "Paguei" (ou "caiu"): lança no mês, marca como pago e desconta uma parcela. Conta de valor variável precisa do valor. */
export async function payBill(userId: string, id: string, opts: { amount?: number | string | null; tz?: string } = {}) {
  const b = await one<Bill>("SELECT * FROM bills WHERE id = $1 AND user_id = $2 AND active", [id, userId]);
  if (!b) throw new Error("Conta não encontrada");
  const tz = opts.tz ?? config.DEFAULT_TIMEZONE;
  const month = todayIn(tz).slice(0, 7);
  if (b.last_paid_month === month) return { already: true, bill: b, transaction: null };
  const amount = opts.amount != null && opts.amount !== "" ? parseAmount(opts.amount) : b.amount != null ? Number(b.amount) : null;
  if (!amount) throw new Error(`Qual foi o valor de ${b.description} este mês?`);
  const tx = await one(
    `INSERT INTO transactions (user_id, kind, amount, category, description, occurred_at, source, external_ref)
     VALUES ($1, $2, $3, $4, $5, now(), 'conta fixa', $6) ON CONFLICT (user_id, external_ref) WHERE external_ref IS NOT NULL DO NOTHING RETURNING *`,
    [userId, b.kind, amount, b.category, b.description, `bill:${b.id}:${month}`],
  );
  const left = b.installments_left != null ? b.installments_left - 1 : null;
  const updated = await one<Bill>(
    "UPDATE bills SET last_paid_month = $2, installments_left = $3, active = ($3::int IS NULL OR $3::int > 0) WHERE id = $1 RETURNING *",
    [b.id, month, left],
  );
  if (tx) void emitEvent("transaction.created", { user_id: userId, id: tx.id, kind: b.kind, amount, category: b.category, description: b.description, source: "conta fixa" });
  return { already: false, bill: updated!, transaction: tx, installments_left: left };
}

/** Acha a conta pelo nome (para o assistente: "paguei o aluguel"). */
export async function findBill(userId: string, name: string) {
  const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const all = await many<Bill>("SELECT * FROM bills WHERE user_id = $1 AND active", [userId]);
  const q = strip(name);
  return all.filter((b) => strip(b.description) === q).concat(all.filter((b) => strip(b.description) !== q && (strip(b.description).includes(q) || q.includes(strip(b.description)))));
}

/** Texto do lembrete do dia para uma pessoa, ou null se não há nada a lembrar. Puro: fácil de testar. */
export function reminderText(bills: Bill[], today: string): { text: string; ids: string[] } | null {
  const lines: string[] = [];
  const ids: string[] = [];
  for (const b of bills) {
    if (b.last_reminded_on && String(b.last_reminded_on).slice(0, 10) === today) continue;
    const s = billStatus(b, today);
    if (s.paid) continue;
    if (b.kind === "income") {
      if (s.days === 0) lines.push(`Hoje deve cair ${b.description}${money(b)}.`);
      else continue;
    } else if (s.days === 0) lines.push(`Hoje vence ${b.description}${money(b)}.`);
    else if (s.days > 0 && s.days === b.remind_days_before) lines.push(`${s.days === 1 ? "Amanhã" : `Dia ${shortDate(s.due)}`} vence ${b.description}${money(b)}.`);
    else if (s.days === -1) lines.push(`${b.description}${money(b)} venceu ontem e ainda não marquei como paga.`);
    else continue;
    ids.push(b.id);
  }
  if (!lines.length) return null;
  const hasExpense = bills.some((b) => ids.includes(b.id) && b.kind === "expense");
  const tail = hasExpense ? "Quando pagar, me fala \"paguei\" que eu lanço nas suas finanças." : "Quando cair, me avisa que eu lanço.";
  return { text: `${lines.join("\n")}\n\n${tail}`, ids };
}

/** Rodada diária (worker, de manhã): uma mensagem por pessoa com as contas do dia. */
export async function remindBills(log?: { info: (...a: any[]) => void; error: (...a: any[]) => void }) {
  const rows = await many<Bill & { timezone: string | null }>(
    `SELECT b.*, u.timezone FROM bills b JOIN users u ON u.id = b.user_id WHERE b.active AND u.status = 'active' ORDER BY b.user_id, b.due_day`,
  );
  const byUser = new Map<string, (Bill & { timezone: string | null })[]>();
  for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
  const { notifyUser } = await import("./social.js");
  let sent = 0;
  for (const [userId, bills] of byUser) {
    const today = todayIn(bills[0]!.timezone ?? config.DEFAULT_TIMEZONE);
    const msg = reminderText(bills, today);
    if (!msg) continue;
    try {
      await notifyUser(userId, msg.text);
      await query("UPDATE bills SET last_reminded_on = $2 WHERE id = ANY($1::uuid[])", [msg.ids, today]);
      sent++;
    } catch (err) {
      log?.error({ err, userId }, "lembrete de contas falhou");
    }
  }
  if (sent) log?.info({ sent }, "lembretes de contas fixas enviados");
  return sent;
}
