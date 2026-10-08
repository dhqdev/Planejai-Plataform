import type { FastifyInstance } from "fastify";
import { budgetStatus, CATEGORIES, guessCategory, parseAmount } from "../../../agent/tools/finance.js";
import { config } from "../../../config.js";
import { many, one, query } from "../../../db/pool.js";
import { NOBODY, personalUser, selfUserId } from "../../../sharing.js";

/**
 * Finanças: lançamentos do mês, categorias e limites de gastos. Cada pessoa vê só as dela (o dono também);
 * as de outra pessoa só se ela compartilhou (?user=), e aí só para ver.
 */
export function financeRoutes(base: FastifyInstance) {
  // ---------- Finanças ----------
  base.get<{ Querystring: { user?: string; month?: string } }>("/api/finance", async (req, reply) => {
    const uid = await personalUser(req.account, req.query.user, "finance");
    if (!uid) return reply.code(403).send({ error: "Essa pessoa não compartilhou as finanças com você" });
    const readonly = uid !== ((await selfUserId(req.account)) ?? NOBODY);
    const tz = config.DEFAULT_TIMEZONE;
    const month = /^\d{4}-\d{2}$/.test(req.query.month ?? "") ? req.query.month! : new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).format(new Date());
    const where = `t.user_id = $1 AND to_char(t.occurred_at AT TIME ZONE $2, 'YYYY-MM') = $3`;
    const totals = await one(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE kind='expense'),0) AS expenses, COALESCE(SUM(amount) FILTER (WHERE kind='income'),0) AS income, COUNT(*) AS count FROM transactions t WHERE ${where}`,
      [uid, tz, month],
    );
    const byCategory = await many(
      `SELECT category, SUM(amount) AS total, COUNT(*) AS count FROM transactions t WHERE ${where} AND kind = 'expense' GROUP BY category ORDER BY total DESC`,
      [uid, tz, month],
    );
    const daily = await many(
      `SELECT to_char(t.occurred_at AT TIME ZONE $2, 'DD') AS day, SUM(amount) FILTER (WHERE kind='expense') AS expenses FROM transactions t WHERE ${where} GROUP BY 1 ORDER BY 1`,
      [uid, tz, month],
    );
    const months = await many(
      `SELECT to_char(t.occurred_at AT TIME ZONE $2, 'YYYY-MM') AS month, COALESCE(SUM(amount) FILTER (WHERE kind='expense'),0) AS expenses, COALESCE(SUM(amount) FILTER (WHERE kind='income'),0) AS income
         FROM transactions t WHERE t.user_id = $1 AND t.occurred_at > now() - interval '6 months' GROUP BY 1 ORDER BY 1`,
      [uid, tz],
    );
    const transactions = await many(
      `SELECT t.id, t.kind, t.amount, t.category, t.description, t.merchant, t.source, t.occurred_at, u.name AS user_name, u.phone
         FROM transactions t JOIN users u ON u.id = t.user_id WHERE ${where} ORDER BY t.occurred_at DESC LIMIT 300`,
      [uid, tz, month],
    );
    const [py, pm] = month.split("-").map(Number) as [number, number];
    const prevMonth = new Date(Date.UTC(py, pm - 2, 1)).toISOString().slice(0, 7);
    const prevByCategory = await many(
      `SELECT category, SUM(amount) AS total FROM transactions t WHERE ${where} AND kind = 'expense' GROUP BY category`,
      [uid, tz, prevMonth],
    );
    const budgets = await budgetStatus(uid, tz, month);
    return { month, totals, byCategory, prevByCategory, daily, months, transactions, budgets, readonly };
  });

  base.post<{ Body: { kind: "expense" | "income"; amount: number | string; category: string; description?: string; date?: string } }>("/api/finance", async (req, reply) => {
    const uid = await selfUserId(req.account);
    if (!uid) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil para lançar" });
    let amount: number;
    try {
      amount = parseAmount(req.body.amount);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    if (amount <= 0) return reply.code(400).send({ error: "Valor precisa ser maior que zero" });
    const when = req.body.date ? new Date(`${req.body.date}T12:00:00`) : new Date();
    return one(
      `INSERT INTO transactions (user_id, kind, amount, category, description, occurred_at, source) VALUES ($1,$2,$3,$4,$5,$6,'painel') RETURNING *`,
      [uid, req.body.kind === "income" ? "income" : "expense", amount, CATEGORIES.includes(req.body.category) ? req.body.category : (guessCategory(req.body.description ?? "") ?? (req.body.kind === "income" ? "Salário" : "Outros")), req.body.description ?? null, when],
    );
  });

  // limites de gastos (category vazia = total do mês)
  base.put<{ Body: { category?: string | null; amount?: number | string } }>("/api/budgets", async (req, reply) => {
    const uid = await selfUserId(req.account);
    if (!uid) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil para criar limites" });
    const category = req.body.category && CATEGORIES.includes(req.body.category) ? req.body.category : null;
    let amount: number;
    try {
      amount = parseAmount(req.body.amount);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    if (amount <= 0) {
      await query("DELETE FROM budgets WHERE user_id = $1 AND COALESCE(category, '*') = COALESCE($2::text, '*')", [uid, category]);
      return { ok: true, removed: true };
    }
    await query(
      `INSERT INTO budgets (user_id, category, amount) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, COALESCE(category, '*')) DO UPDATE SET amount = $3, alerted_level = 0, alerted_month = NULL`,
      [uid, category, amount],
    );
    return { ok: true };
  });

  // editar um lançamento próprio (valor, categoria, descrição, data, gasto/receita)
  base.patch<{ Params: { id: string }; Body: { kind?: string; amount?: number | string; category?: string; description?: string | null; date?: string } }>("/api/finance/:id", async (req, reply) => {
    const b = req.body ?? {};
    let amount: number | null = null;
    if (b.amount != null && b.amount !== "") {
      try {
        amount = parseAmount(b.amount);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      if (amount <= 0) return reply.code(400).send({ error: "Valor precisa ser maior que zero" });
    }
    if (b.category && !CATEGORIES.includes(b.category)) return reply.code(400).send({ error: "Categoria inválida" });
    if (b.date && !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return reply.code(400).send({ error: "Data inválida" });
    const row = await one(
      `UPDATE transactions SET kind = COALESCE($3, kind), amount = COALESCE($4, amount), category = COALESCE($5, category),
              description = CASE WHEN $6::boolean THEN $7 ELSE description END, occurred_at = COALESCE($8, occurred_at)
        WHERE id = $1 AND user_id = $2 RETURNING *`,
      [
        req.params.id,
        (await selfUserId(req.account)) ?? NOBODY,
        b.kind === "income" || b.kind === "expense" ? b.kind : null,
        amount,
        b.category || null,
        b.description !== undefined,
        b.description ? String(b.description).slice(0, 200) : null,
        b.date ? new Date(`${b.date}T12:00:00`) : null,
      ],
    );
    if (!row) return reply.code(404).send({ error: "Lançamento não encontrado" });
    return row;
  });

  base.delete<{ Params: { id: string } }>("/api/finance/:id", async (req) => {
    const r = await query("DELETE FROM transactions WHERE id = $1 AND user_id = $2", [req.params.id, (await selfUserId(req.account)) ?? NOBODY]);
    return { ok: (r.rowCount ?? 0) > 0 };
  });

  base.get("/api/finance/categories", async () => CATEGORIES);
}
