import { config } from "../../config.js";
import { randomUUID } from "node:crypto";
import { many, one, query } from "../../db/pool.js";
import { getCredentials } from "../../integrations/registry.js";
import { parseLocalDateTime } from "../../time.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

export const CATEGORIES = [
  "Alimentação",
  "Mercado",
  "Transporte",
  "Moradia",
  "Saúde",
  "Educação",
  "Lazer",
  "Compras",
  "Assinaturas",
  "Contas",
  "Viagem",
  "Salário",
  "Investimentos",
  "Outros",
];

/** Converte "R$ 1.234,56", "8,20", "1234.5", 12 em número com 2 casas (centavos exatos). */
export function parseAmount(v: unknown): number {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("Valor inválido");
    return Math.round(Math.abs(v) * 100) / 100;
  }
  let s = String(v ?? "").replace(/[R$\s]/gi, "").replace(/^-/, "");
  if (!s) throw new Error("Valor vazio");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", "."); // 1.234,56
  else if (lastDot > lastComma && lastComma >= 0) s = s.replace(/,/g, ""); // 1,234.56
  else if (lastDot >= 0 && /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ""); // 1.234 = mil duzentos...
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Valor inválido: ${v}`);
  return Math.round(Math.abs(n) * 100) / 100;
}

export const brl = (n: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n).replace(/\u00a0/g, " ");
const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;

/** Divide um total em N parcelas sem perder centavos (a diferença vai na primeira). */
export function splitInstallments(total: number, n: number): number[] {
  const totalCents = Math.round(total * 100);
  const base = Math.floor(totalCents / n);
  const parts = Array.from({ length: n }, () => base);
  parts[0]! += totalCents - base * n;
  return parts.map((c) => c / 100);
}

/** Avaliador aritmético seguro (sem eval): + - * / % ^ parênteses, vírgula decimal e "x" como vezes. */
export function calc(expression: string): number {
  const src = expression.replace(/(\d),(\d)/g, "$1.$2").replace(/[x×]/gi, "*").replace(/÷/g, "/").replace(/R\$/gi, "");
  let i = 0;
  const peek = () => src[i];
  const skip = () => {
    while (src[i] === " ") i++;
  };
  function num(): number {
    skip();
    if (peek() === "(") {
      i++;
      const v = expr();
      skip();
      if (src[i++] !== ")") throw new Error("parêntese faltando");
      return v;
    }
    if (peek() === "-") {
      i++;
      return -num();
    }
    const m = src.slice(i).match(/^\d+(\.\d+)?/);
    if (!m) throw new Error(`não entendi a expressão perto de "${src.slice(i, i + 8)}"`);
    i += m[0].length;
    skip();
    if (peek() === "%") {
      i++;
      return Number(m[0]) / 100;
    }
    return Number(m[0]);
  }
  function pow(): number {
    const b = num();
    skip();
    if (peek() === "^") {
      i++;
      return b ** pow();
    }
    return b;
  }
  function term(): number {
    let v = pow();
    for (;;) {
      skip();
      const op = peek();
      if (op !== "*" && op !== "/") return v;
      i++;
      const r = pow();
      if (op === "/" && r === 0) throw new Error("divisão por zero");
      v = op === "*" ? v * r : v / r;
    }
  }
  function expr(): number {
    let v = term();
    for (;;) {
      skip();
      const op = peek();
      if (op !== "+" && op !== "-") return v;
      i++;
      v = op === "+" ? v + term() : v - term();
    }
  }
  const v = expr();
  skip();
  if (i < src.length) throw new Error(`sobrou "${src.slice(i)}" na expressão`);
  return v;
}

export const calculate = defineTool<{ expression: string }>({
  name: "calculate",
  description:
    "Calculadora exata. Use SEMPRE que precisar somar, dividir conta, calcular parcela, juros, porcentagem, troco ou média, em vez de fazer de cabeça. " +
    "Ex.: '(89,90 + 45,50) / 3', '1200 * 12%', '2500 * (1 + 1,5%)^12'.",
  parameters: obj({ expression: { type: "string" } }, ["expression"]),
  async run(args) {
    const v = calc(args.expression);
    return { expression: args.expression, result: Math.round(v * 1e6) / 1e6, result_2_decimals: Math.round(v * 100) / 100, formatted_brl: brl(Math.round(v * 100) / 100) };
  },
});

async function monthTotals(userId: string, timezone: string, when: Date, category: string) {
  const r = await one(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE kind='expense'),0) AS expenses,
            COALESCE(SUM(amount) FILTER (WHERE kind='income'),0) AS income,
            COALESCE(SUM(amount) FILTER (WHERE kind='expense' AND category=$4),0) AS category_total
       FROM transactions WHERE user_id = $1
        AND date_trunc('month', occurred_at AT TIME ZONE $2) = date_trunc('month', $3::timestamptz AT TIME ZONE $2)`,
    [userId, timezone, when, category],
  );
  return {
    month_expenses: brl(cents(r?.expenses)),
    month_income: brl(cents(r?.income)),
    month_category_total: brl(cents(r?.category_total)),
  };
}

export const addTransaction = defineTool<{
  kind: "expense" | "income";
  amount: number | string;
  category: string;
  description?: string;
  merchant?: string;
  date?: string;
  installments?: number;
  source?: string;
  message_id?: string;
}>({
  name: "add_transaction",
  description:
    "Registra um gasto ou receita da pessoa (ex.: 'gastei 8,20 na padaria', foto de comprovante/nota, Pix, documento de fatura). " +
    "Não precisa pedir confirmação. Para compra parcelada informe o valor TOTAL e installments (cria uma parcela por mês). " +
    "Passe message_id da mensagem de origem (evita lançar o mesmo comprovante duas vezes).",
  parameters: obj(
    {
      kind: { type: "string", enum: ["expense", "income"] },
      amount: { type: "number", description: "Valor TOTAL em reais com ponto decimal (ex.: 1234.56)" },
      category: { type: "string", enum: CATEGORIES },
      description: { type: "string" },
      merchant: { type: "string", description: "Estabelecimento/pessoa" },
      date: { type: "string", description: "AAAA-MM-DD ou AAAA-MM-DDTHH:MM local; padrão agora" },
      installments: { type: "number", description: "Número de parcelas (padrão 1)" },
      source: { type: "string", enum: ["conversa", "audio", "comprovante", "documento"] },
      message_id: { type: "string" },
    },
    ["kind", "amount", "category"],
  ),
  async run(args, ctx) {
    const total = parseAmount(args.amount);
    if (total <= 0) return { ok: false, error: "Valor precisa ser maior que zero" };
    const category = CATEGORIES.includes(args.category) ? args.category : "Outros";
    const first = args.date ? parseLocalDateTime(args.date, ctx.timezone) : new Date();
    const n = Math.min(Math.max(1, Math.floor(args.installments ?? 1)), 48);
    const parts = splitInstallments(total, n);
    const ids: string[] = [];
    for (const [i, amount] of parts.entries()) {
      const when = new Date(first);
      when.setMonth(when.getMonth() + i);
      const ref = args.message_id ? `${args.message_id}:${i}` : null;
      const desc = n > 1 ? `${args.description ?? args.merchant ?? category} (${i + 1}/${n})` : (args.description ?? null);
      const row = await one(
        `INSERT INTO transactions (user_id, kind, amount, category, description, merchant, occurred_at, source, external_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (user_id, external_ref) WHERE external_ref IS NOT NULL DO NOTHING RETURNING id`,
        [ctx.user.id, args.kind, amount, category, desc, args.merchant ?? null, when, args.source ?? "conversa", ref],
      );
      if (!row) return { ok: true, duplicate: true, note: "Esse comprovante/mensagem já tinha sido lançado; nada foi duplicado." };
      ids.push(row.id);
    }
    return {
      ok: true,
      ids,
      amount: brl(total),
      ...(n > 1 ? { installments: n, installment_values: parts.map(brl) } : {}),
      category,
      ...(await monthTotals(ctx.user.id, ctx.timezone, first, category)),
    };
  },
});

export const listTransactions = defineTool<{ from?: string; to?: string; category?: string; limit?: number }>({
  name: "list_transactions",
  description: "Lista lançamentos financeiros, com filtros.",
  parameters: obj({
    from: { type: "string", description: "AAAA-MM-DD" },
    to: { type: "string", description: "AAAA-MM-DD (inclusivo)" },
    category: { type: "string" },
    limit: { type: "number" },
  }),
  async run(args, ctx) {
    const from = args.from ? parseLocalDateTime(args.from, ctx.timezone) : new Date(Date.now() - 30 * 86_400_000);
    const to = args.to ? new Date(parseLocalDateTime(args.to, ctx.timezone).getTime() + 86_400_000) : new Date(Date.now() + 86_400_000);
    return many(
      `SELECT id, kind, amount, category, description, merchant, to_char(occurred_at AT TIME ZONE $6, 'DD/MM/YYYY HH24:MI') AS quando FROM transactions
        WHERE user_id = $1 AND occurred_at >= $2 AND occurred_at < $3 AND ($4::text IS NULL OR category = $4)
        ORDER BY occurred_at DESC LIMIT $5`,
      [ctx.user.id, from, to, args.category ?? null, Math.min(args.limit ?? 50, 200), ctx.timezone],
    ).then((rows) => {
      const total = rows.reduce((acc, r) => acc + Math.round(Number(r.amount) * 100) * (r.kind === "expense" ? 1 : 0), 0) / 100;
      return { count: rows.length, total_expenses_listed: brl(total), items: rows };
    });
  },
});

export const financeSummary = defineTool<{ month?: string }>({
  name: "finance_summary",
  description: "Resumo do mês: total de gastos, receitas, saldo e gastos por categoria.",
  parameters: obj({ month: { type: "string", description: "AAAA-MM; padrão mês atual" } }),
  async run(args, ctx) {
    const month = args.month ?? new Intl.DateTimeFormat("en-CA", { timeZone: ctx.timezone, year: "numeric", month: "2-digit" }).format(new Date());
    const where = `user_id = $1 AND to_char(occurred_at AT TIME ZONE $2, 'YYYY-MM') = $3`;
    const totals = await one(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE kind='expense'),0) AS expenses, COALESCE(SUM(amount) FILTER (WHERE kind='income'),0) AS income, COUNT(*) AS count FROM transactions WHERE ${where}`,
      [ctx.user.id, ctx.timezone, month],
    );
    const byCategory = await many(
      `SELECT category, SUM(amount) AS total, COUNT(*) AS count FROM transactions WHERE ${where} AND kind='expense' GROUP BY category ORDER BY total DESC`,
      [ctx.user.id, ctx.timezone, month],
    );
    const prev = await one(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE kind='expense'),0) AS expenses FROM transactions
        WHERE user_id = $1 AND to_char(occurred_at AT TIME ZONE $2, 'YYYY-MM') = to_char(to_date($3, 'YYYY-MM') - interval '1 month', 'YYYY-MM')`,
      [ctx.user.id, ctx.timezone, month],
    );
    const expenses = cents(totals?.expenses);
    const income = cents(totals?.income);
    return {
      month,
      expenses: brl(expenses),
      income: brl(income),
      balance: brl(cents(income - expenses)),
      count: Number(totals?.count ?? 0),
      previous_month_expenses: brl(cents(prev?.expenses)),
      by_category: byCategory.map((c) => ({
        category: c.category,
        total: brl(cents(c.total)),
        count: Number(c.count),
        share: expenses ? `${Math.round((Number(c.total) / expenses) * 100)}%` : "0%",
      })),
    };
  },
});

export const deleteTransaction = defineTool<{ id: string }>({
  name: "delete_transaction",
  description: "Apaga um lançamento (ex.: quando a pessoa diz que anotou errado).",
  parameters: obj({ id: { type: "string" } }, ["id"]),
  async run(args, ctx) {
    const r = await query("DELETE FROM transactions WHERE id = $1 AND user_id = $2", [args.id, ctx.user.id]);
    return { ok: (r.rowCount ?? 0) > 0 };
  },
});

export const createPaymentLink = defineTool<{ title: string; amount: number; quantity?: number; provider?: "mercadopago" | "stripe"; confirmed_by_user?: boolean }>({
  name: "create_payment_link",
  description:
    "Gera um link de pagamento (Mercado Pago: Pix/cartão/boleto, ou Stripe) para cobrar alguém ou pagar algo. " +
    "Exige confirmação explícita da pessoa com valor e descrição.",
  parameters: obj(
    {
      title: { type: "string" },
      amount: { type: "number", description: "Valor unitário em BRL" },
      quantity: { type: "number" },
      provider: { type: "string", enum: ["mercadopago", "stripe"] },
      ...CONFIRM_PARAM,
    },
    ["title", "amount"],
  ),
  async run(args) {
    const qty = Math.max(1, Math.floor(args.quantity ?? 1));
    const amount = parseAmount(args.amount);
    const c = requireConfirmation(args, `gerar link de pagamento "${args.title}" de ${brl(Math.round(amount * qty * 100) / 100)}`);
    if (c) return c;
    const mp = args.provider !== "stripe" ? await getCredentials("mercadopago") : null;
    if (mp) {
      const res = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST",
        headers: { Authorization: `Bearer ${mp.access_token}`, "Content-Type": "application/json", "X-Idempotency-Key": randomUUID() },
        body: JSON.stringify({ items: [{ title: args.title, quantity: qty, unit_price: amount, currency_id: "BRL" }] }),
      });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Mercado Pago: ${JSON.stringify(j).slice(0, 300)}`);
      return { provider: "mercadopago", url: j.init_point, id: j.id };
    }
    const stripe = await getCredentials("stripe");
    if (stripe) {
      const body = new URLSearchParams({
        mode: "payment",
        success_url: `${config.PUBLIC_URL.replace(/\/$/, "")}/pagamento-ok`,
        "line_items[0][quantity]": String(qty),
        "line_items[0][price_data][currency]": "brl",
        "line_items[0][price_data][unit_amount]": String(Math.round(amount * 100)),
        "line_items[0][price_data][product_data][name]": args.title,
      });
      const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${stripe.secret_key}`, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Stripe: ${j.error?.message}`);
      return { provider: "stripe", url: j.url, id: j.id };
    }
    return { ok: false, error: "Nenhuma integração de pagamento conectada (Mercado Pago ou Stripe). Conecte no dashboard." };
  },
});
