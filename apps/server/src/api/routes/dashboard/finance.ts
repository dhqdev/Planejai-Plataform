import type { FastifyInstance } from "fastify";
import { budgetStatus, parseAmount, recordTransaction } from "../../../agent/tools/finance.js";
import { autoCategory, createCategory, DEFAULT_CATEGORIES, deleteCategory, learnCategory, listCategories, resolveCategory, updateCategory, type CategoryInput } from "../../../categories.js";
import { config } from "../../../config.js";
import { many, one, query } from "../../../db/pool.js";
import { NOBODY, personalUser, personalUsers, selfUserId } from "../../../sharing.js";
import { createBill, deleteBill, listBills, payBill, updateBill, type BillInput } from "../../../bills.js";
import { getReportSchedule, renderFinanceReport, reportFileName, sendFinanceReport, setReportSchedule } from "../../../finance-report.js";
import { createCard, deleteCard, getCard, invoiceItems, listCards, placeOnCard, payInvoice, unpayInvoice, updateCard, type CardInput } from "../../../cards.js";

/**
 * Finanças: lançamentos do mês, categorias e limites de gastos. Cada pessoa vê só as dela (o dono também);
 * as de outra pessoa só se ela compartilhou (?user=), e aí só para ver.
 */
export function financeRoutes(base: FastifyInstance) {
  // ---------- Finanças ----------
  base.get<{ Querystring: { user?: string; month?: string } }>("/api/finance", async (req, reply) => {
    const uids = await personalUsers(req.account, req.query.user, "finance");
    if (!uids || !uids.length) return reply.code(403).send({ error: "Essa pessoa não compartilhou as finanças com você" });
    const me = (await selfUserId(req.account)) ?? NOBODY;
    const readonly = uids.length !== 1 || uids[0] !== me;
    const tz = config.DEFAULT_TIMEZONE;
    const month = /^\d{4}-\d{2}$/.test(req.query.month ?? "") ? req.query.month! : new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).format(new Date());
    const where = `t.user_id = ANY($1) AND to_char(t.occurred_at AT TIME ZONE $2, 'YYYY-MM') = $3`;
    const totals = await one(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE kind='expense'),0) AS expenses, COALESCE(SUM(amount) FILTER (WHERE kind='income'),0) AS income, COUNT(*) AS count FROM transactions t WHERE ${where}`,
      [uids, tz, month],
    );
    const byCategory = await many(
      `SELECT category, SUM(amount) AS total, COUNT(*) AS count FROM transactions t WHERE ${where} AND kind = 'expense' GROUP BY category ORDER BY total DESC`,
      [uids, tz, month],
    );
    const daily = await many(
      `SELECT to_char(t.occurred_at AT TIME ZONE $2, 'DD') AS day, SUM(amount) FILTER (WHERE kind='expense') AS expenses FROM transactions t WHERE ${where} GROUP BY 1 ORDER BY 1`,
      [uids, tz, month],
    );
    const months = await many(
      `SELECT to_char(t.occurred_at AT TIME ZONE $2, 'YYYY-MM') AS month, COALESCE(SUM(amount) FILTER (WHERE kind='expense'),0) AS expenses, COALESCE(SUM(amount) FILTER (WHERE kind='income'),0) AS income
         FROM transactions t WHERE t.user_id = ANY($1) AND t.occurred_at > now() - interval '6 months' GROUP BY 1 ORDER BY 1`,
      [uids, tz],
    );
    const transactions = await many(
      `SELECT t.id, t.kind, t.amount, t.category, t.description, t.merchant, t.source, t.occurred_at, u.name AS user_name, u.phone,
              t.card_id, c.name AS card_name, c.color AS card_color, t.invoice_month, t.installment, t.installments
         FROM transactions t JOIN users u ON u.id = t.user_id LEFT JOIN cards c ON c.id = t.card_id WHERE ${where} ORDER BY t.occurred_at DESC LIMIT 300`,
      [uids, tz, month],
    );
    const [py, pm] = month.split("-").map(Number) as [number, number];
    const prevMonth = new Date(Date.UTC(py, pm - 2, 1)).toISOString().slice(0, 7);
    const prevByCategory = await many(
      `SELECT category, SUM(amount) AS total FROM transactions t WHERE ${where} AND kind = 'expense' GROUP BY category`,
      [uids, tz, prevMonth],
    );
    const budgets = uids.length === 1 ? await budgetStatus(uids[0]!, tz, month) : [];
    return { month, totals, byCategory, prevByCategory, daily, months, transactions, budgets, readonly };
  });

  base.post<{ Body: { kind: "expense" | "income"; amount: number | string; category: string; description?: string; date?: string; card_id?: string | null; installments?: number | string } }>("/api/finance", async (req, reply) => {
    const uid = await selfUserId(req.account);
    if (!uid) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil para lançar" });
    let amount: number;
    try {
      amount = parseAmount(req.body.amount);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    if (amount <= 0) return reply.code(400).send({ error: "Valor precisa ser maior que zero" });
    const when = req.body.date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date) ? new Date(`${req.body.date}T12:00:00`) : new Date();
    const card = req.body.card_id ? await getCard(uid, req.body.card_id) : null;
    if (req.body.card_id && !card) return reply.code(400).send({ error: "Cartão não encontrado" });
    const kind = req.body.kind === "income" ? "income" : "expense";
    const r = await recordTransaction({
      userId: uid,
      kind,
      total: amount,
      category: (req.body.category && (await resolveCategory(uid, req.body.category))?.name) || (await autoCategory(uid, kind, null, req.body.description)).category,
      description: req.body.description?.trim().slice(0, 200) || null,
      first: when,
      installments: Number(req.body.installments) || 1,
      source: "painel",
      card,
      tz: config.DEFAULT_TIMEZONE,
    });
    return { ok: true, ids: r.ids, invoices: r.invoices };
  });

  // limites de gastos (category vazia = total do mês)
  base.put<{ Body: { category?: string | null; amount?: number | string } }>("/api/budgets", async (req, reply) => {
    const uid = await selfUserId(req.account);
    if (!uid) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil para criar limites" });
    const category = req.body.category ? ((await resolveCategory(uid, req.body.category))?.name ?? null) : null;
    if (req.body.category && !category) return reply.code(400).send({ error: "Categoria não encontrada" });
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
  base.patch<{ Params: { id: string }; Body: { kind?: string; amount?: number | string; category?: string; description?: string | null; date?: string; card_id?: string | null } }>("/api/finance/:id", async (req, reply) => {
    const b = req.body ?? {};
    const me = (await selfUserId(req.account)) ?? NOBODY;
    const card = b.card_id ? await getCard(me, b.card_id) : null;
    if (b.card_id && !card) return reply.code(400).send({ error: "Cartão não encontrado" });
    let amount: number | null = null;
    if (b.amount != null && b.amount !== "") {
      try {
        amount = parseAmount(b.amount);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      if (amount <= 0) return reply.code(400).send({ error: "Valor precisa ser maior que zero" });
    }
    const category = b.category ? ((await resolveCategory(me, b.category))?.name ?? null) : null;
    if (b.category && !category) return reply.code(400).send({ error: "Categoria não encontrada" });
    const before = category ? await one("SELECT category FROM transactions WHERE id = $1 AND user_id = $2", [req.params.id, me]) : null;
    if (b.date && !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return reply.code(400).send({ error: "Data inválida" });
    const row = await one(
      `UPDATE transactions SET kind = COALESCE($3, kind), amount = COALESCE($4, amount), category = COALESCE($5, category),
              description = CASE WHEN $6::boolean THEN $7 ELSE description END, occurred_at = COALESCE($8, occurred_at)
        WHERE id = $1 AND user_id = $2 RETURNING *`,
      [
        req.params.id,
        me,
        b.kind === "income" || b.kind === "expense" ? b.kind : null,
        amount,
        category,
        b.description !== undefined,
        b.description ? String(b.description).slice(0, 200) : null,
        b.date ? new Date(`${b.date}T12:00:00`) : null,
      ],
    );
    if (!row) return reply.code(404).send({ error: "Lançamento não encontrado" });
    // trocou a categoria: os próximos parecidos já vão para ela
    if (category && before && before.category !== category) await learnCategory(me, [{ kind: row.kind, category, merchant: row.merchant, description: row.description }]);
    // trocou de cartão (ou tirou do cartão) ou mudou a data: recalcula a fatura
    if (b.card_id !== undefined && (b.card_id ?? null) !== (row.card_id ?? null)) {
      await query("UPDATE transactions SET card_id = $2, invoice_month = NULL WHERE id = $1", [row.id, card?.id ?? null]);
      if (card) await placeOnCard(me, card, [row.id]);
    } else if (b.date && row.card_id) {
      const current = await getCard(me, row.card_id);
      if (current) await placeOnCard(me, current, [row.id]);
    }
    return row;
  });

  base.delete<{ Params: { id: string } }>("/api/finance/:id", async (req) => {
    const r = await query("DELETE FROM transactions WHERE id = $1 AND user_id = $2", [req.params.id, (await selfUserId(req.account)) ?? NOBODY]);
    return { ok: (r.rowCount ?? 0) > 0 };
  });

  // categorias da pessoa (as de um contato que compartilhou: só para ver as cores e nomes)
  base.get<{ Querystring: { user?: string; month?: string } }>("/api/finance/categories", async (req, reply) => {
    const uid = await personalUser(req.account, req.query.user, "finance");
    if (!uid) return reply.code(403).send({ error: "Essa pessoa não compartilhou as finanças com você" });
    // conta sem WhatsApp ligado: só mostra as de sempre, sem gravar nada
    if (uid === NOBODY) return DEFAULT_CATEGORIES.map((c, i) => ({ id: c.name, ...c, keywords: [], aliases: [], position: i, count: 0, month_total: 0, fixed: c.name === "Outros" }));
    return listCategories(uid, config.DEFAULT_TIMEZONE, /^\d{4}-\d{2}$/.test(req.query.month ?? "") ? req.query.month : undefined);
  });

  const own = async (req: { account: any }, reply: any) => {
    const uid = await selfUserId(req.account);
    if (!uid) reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil para mexer nas categorias" });
    return uid;
  };
  base.post<{ Body: CategoryInput }>("/api/finance/categories", async (req, reply) => {
    const uid = await own(req, reply);
    if (!uid) return reply;
    try {
      return await createCategory(uid, req.body ?? {});
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  base.patch<{ Params: { id: string }; Body: CategoryInput }>("/api/finance/categories/:id", async (req, reply) => {
    const uid = await own(req, reply);
    if (!uid) return reply;
    try {
      return await updateCategory(uid, req.params.id, req.body ?? {});
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  base.delete<{ Params: { id: string }; Querystring: { move_to?: string } }>("/api/finance/categories/:id", async (req, reply) => {
    const uid = await own(req, reply);
    if (!uid) return reply;
    try {
      return { ok: true, ...(await deleteCategory(uid, req.params.id, req.query.move_to)) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // ---------- Relatório em PDF (baixar, mandar no WhatsApp agora e envio todo mês no dia escolhido) ----------
  const monthOf = (m?: string) => (/^\d{4}-\d{2}$/.test(m ?? "") ? m! : new Intl.DateTimeFormat("en-CA", { timeZone: config.DEFAULT_TIMEZONE, year: "numeric", month: "2-digit" }).format(new Date()));
  base.get<{ Querystring: { user?: string; month?: string } }>("/api/finance/report", async (req, reply) => {
    const uid = await personalUser(req.account, req.query.user, "finance");
    if (!uid) return reply.code(403).send({ error: "Essa pessoa não compartilhou as finanças com você" });
    const month = monthOf(req.query.month);
    try {
      const pdf = await renderFinanceReport(uid, month);
      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `attachment; filename="relatorio-${month}.pdf"; filename*=UTF-8''${encodeURIComponent(reportFileName(month))}`)
        .header("Cache-Control", "no-store")
        .send(pdf);
    } catch (err) {
      req.log.error({ err }, "relatório financeiro falhou");
      return reply.code(503).send({ error: "Não consegui gerar o PDF agora. Tente de novo em instantes." });
    }
  });

  base.post<{ Body: { month?: string } }>("/api/finance/report/send", async (req, reply) => {
    const uid = await selfUserId(req.account);
    if (!uid) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil para receber o relatório" });
    try {
      return { ok: true, ...(await sendFinanceReport(uid, monthOf(req.body?.month))) };
    } catch (err) {
      req.log.error({ err }, "envio do relatório financeiro falhou");
      return reply.code(503).send({ error: "Não consegui mandar o relatório agora. Tente de novo em instantes." });
    }
  });

  base.get("/api/finance/report/schedule", async (req) => {
    const uid = await selfUserId(req.account);
    return { schedule: uid ? await getReportSchedule(uid) : null, linked: Boolean(uid) };
  });

  base.put<{ Body: { day?: number | null } }>("/api/finance/report/schedule", async (req, reply) => {
    const uid = await selfUserId(req.account);
    if (!uid) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil para agendar o relatório" });
    try {
      return { schedule: await setReportSchedule(uid, req.body?.day ?? null) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // ---------- Contas fixas (lembrete antes do vencimento; "paguei" lança no mês) ----------
  base.get<{ Querystring: { user?: string } }>("/api/bills", async (req, reply) => {
    const uid = await personalUser(req.account, req.query.user, "finance");
    if (!uid) return reply.code(403).send({ error: "Essa pessoa não compartilhou as finanças com você" });
    return listBills(uid);
  });

  const mine = async (req: { account: any }, reply: any) => {
    const uid = await selfUserId(req.account);
    if (!uid) reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil para usar contas fixas" });
    return uid;
  };
  const fail = (reply: any, err: unknown) => reply.code(400).send({ error: (err as Error).message });

  base.post<{ Body: BillInput }>("/api/bills", async (req, reply) => {
    const uid = await mine(req, reply);
    if (!uid) return;
    try {
      return await createBill(uid, req.body ?? {});
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.patch<{ Params: { id: string }; Body: BillInput }>("/api/bills/:id", async (req, reply) => {
    const uid = await mine(req, reply);
    if (!uid) return;
    try {
      const row = await updateBill(uid, req.params.id, req.body ?? {});
      return row ?? reply.code(404).send({ error: "Conta não encontrada" });
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.post<{ Params: { id: string }; Body: { amount?: number | string | null } }>("/api/bills/:id/pay", async (req, reply) => {
    const uid = await mine(req, reply);
    if (!uid) return;
    try {
      return await payBill(uid, req.params.id, { amount: req.body?.amount ?? null });
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.delete<{ Params: { id: string } }>("/api/bills/:id", async (req) => ({ ok: await deleteBill((await selfUserId(req.account)) ?? NOBODY, req.params.id) }));

  // ---------- Cartões de crédito e faturas ----------
  base.get<{ Querystring: { user?: string } }>("/api/cards", async (req, reply) => {
    const uid = await personalUser(req.account, req.query.user, "finance");
    if (!uid) return reply.code(403).send({ error: "Essa pessoa não compartilhou as finanças com você" });
    return { cards: await listCards(uid), readonly: uid !== ((await selfUserId(req.account)) ?? NOBODY) };
  });

  base.get<{ Params: { id: string }; Querystring: { user?: string; month?: string } }>("/api/cards/:id/invoice", async (req, reply) => {
    const uid = await personalUser(req.account, req.query.user, "finance");
    if (!uid) return reply.code(403).send({ error: "Essa pessoa não compartilhou as finanças com você" });
    const card = await getCard(uid, req.params.id);
    if (!card) return reply.code(404).send({ error: "Cartão não encontrado" });
    if (!/^\d{4}-\d{2}$/.test(req.query.month ?? "")) return reply.code(400).send({ error: "Mês da fatura em AAAA-MM" });
    return invoiceItems(uid, card, req.query.month!);
  });

  base.post<{ Body: CardInput }>("/api/cards", async (req, reply) => {
    const uid = await mine(req, reply);
    if (!uid) return;
    try {
      return await createCard(uid, req.body ?? {});
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.patch<{ Params: { id: string }; Body: CardInput }>("/api/cards/:id", async (req, reply) => {
    const uid = await mine(req, reply);
    if (!uid) return;
    if (!(await getCard(uid, req.params.id))) return reply.code(404).send({ error: "Cartão não encontrado" });
    try {
      return await updateCard(uid, req.params.id, req.body ?? {});
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.delete<{ Params: { id: string } }>("/api/cards/:id", async (req) => {
    const uid = (await selfUserId(req.account)) ?? NOBODY;
    return { ok: (await getCard(uid, req.params.id)) ? await deleteCard(uid, req.params.id) : false };
  });

  // marcar fatura como paga (não lança gasto: as compras já estão nos lançamentos) e desfazer
  base.post<{ Params: { id: string; month: string }; Body: { amount?: number | string | null } }>("/api/cards/:id/invoices/:month/pay", async (req, reply) => {
    const uid = await mine(req, reply);
    if (!uid) return;
    const card = await getCard(uid, req.params.id);
    if (!card) return reply.code(404).send({ error: "Cartão não encontrado" });
    try {
      return await payInvoice(uid, card, req.params.month, req.body?.amount ?? null);
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.delete<{ Params: { id: string; month: string } }>("/api/cards/:id/invoices/:month/pay", async (req, reply) => {
    const uid = (await selfUserId(req.account)) ?? NOBODY;
    const card = await getCard(uid, req.params.id);
    if (!card) return reply.code(404).send({ error: "Cartão não encontrado" });
    return { ok: await unpayInvoice(card, req.params.month) };
  });
}
