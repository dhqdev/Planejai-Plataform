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

export const addTransaction = defineTool<{ kind: "expense" | "income"; amount: number; category: string; description?: string; date?: string }>({
  name: "add_transaction",
  description: "Registra um gasto ou receita (ex.: 'gastei 8,20 na padaria').",
  parameters: obj(
    {
      kind: { type: "string", enum: ["expense", "income"] },
      amount: { type: "number", description: "Valor em reais, positivo" },
      category: { type: "string", enum: CATEGORIES },
      description: { type: "string" },
      date: { type: "string", description: "AAAA-MM-DD ou AAAA-MM-DDTHH:MM local; padrão agora" },
    },
    ["kind", "amount", "category"],
  ),
  async run(args, ctx) {
    const when = args.date ? parseLocalDateTime(args.date, ctx.timezone) : new Date();
    const row = await one(
      `INSERT INTO transactions (user_id, kind, amount, category, description, occurred_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ctx.user.id, args.kind, Math.abs(args.amount), args.category, args.description ?? null, when],
    );
    const month = await one(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE kind='expense'),0) AS expenses,
              COALESCE(SUM(amount) FILTER (WHERE kind='expense' AND category=$3),0) AS category_total
         FROM transactions WHERE user_id = $1 AND date_trunc('month', occurred_at AT TIME ZONE $2) = date_trunc('month', now() AT TIME ZONE $2)`,
      [ctx.user.id, ctx.timezone, args.category],
    );
    return { ok: true, id: row!.id, month_expenses: month?.expenses, month_category_total: month?.category_total };
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
      `SELECT id, kind, amount, category, description, occurred_at FROM transactions
        WHERE user_id = $1 AND occurred_at >= $2 AND occurred_at < $3 AND ($4::text IS NULL OR category = $4)
        ORDER BY occurred_at DESC LIMIT $5`,
      [ctx.user.id, from, to, args.category ?? null, Math.min(args.limit ?? 50, 200)],
    );
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
    return { month, ...totals, balance: Number(totals?.income ?? 0) - Number(totals?.expenses ?? 0), by_category: byCategory };
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
    const qty = args.quantity ?? 1;
    const c = requireConfirmation(args, `gerar link de pagamento "${args.title}" de R$ ${(args.amount * qty).toFixed(2)}`);
    if (c) return c;
    const mp = args.provider !== "stripe" ? await getCredentials("mercadopago") : null;
    if (mp) {
      const res = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST",
        headers: { Authorization: `Bearer ${mp.access_token}`, "Content-Type": "application/json", "X-Idempotency-Key": randomUUID() },
        body: JSON.stringify({ items: [{ title: args.title, quantity: qty, unit_price: args.amount, currency_id: "BRL" }] }),
      });
      const j: any = await res.json();
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
        "line_items[0][price_data][unit_amount]": String(Math.round(args.amount * 100)),
        "line_items[0][price_data][product_data][name]": args.title,
      });
      const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${stripe.secret_key}`, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const j: any = await res.json();
      if (!res.ok) throw new Error(`Stripe: ${j.error?.message}`);
      return { provider: "stripe", url: j.url, id: j.id };
    }
    return { ok: false, error: "Nenhuma integração de pagamento conectada (Mercado Pago ou Stripe). Conecte no dashboard." };
  },
});
