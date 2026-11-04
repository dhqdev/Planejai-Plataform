import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Mês financeiro (pedido do David em 2026-11-04): "se recebo todo dia 5, meu mês começa no dia 5".
 * Totais, limites, resumo do Moacir, atalho "quanto gastei no mês", cartão do chat e relatório seguem o período dela.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("mês financeiro (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let fin: typeof import("../src/agent/tools/finance.js");
  let ctx: any;
  const tz = "America/Sao_Paulo";

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    const { upsertUser } = await import("../src/ingest.js");
    const user = await upsertUser("5519933334444", "Davi");
    await db.query("UPDATE users SET status = 'active' WHERE id = $1", [user.id]);
    ctx = { user, timezone: tz };
    fin = await import("../src/agent/tools/finance.js");
    const add = (kind: string, amount: number, at: string, description: string) =>
      db.query("INSERT INTO transactions (user_id, kind, amount, category, description, occurred_at, source) VALUES ($1, $2, $3, $4, $5, $6, 'painel')", [
        user.id,
        kind,
        amount,
        kind === "income" ? "Salário" : "Mercado",
        description,
        `${at}T12:00:00-03:00`,
      ]);
    await add("expense", 100, "2026-10-04", "fim do mês anterior");
    await add("income", 3000, "2026-10-05", "salário de outubro");
    await add("expense", 50.25, "2026-10-20", "mercado");
    await add("expense", 30, "2026-11-04", "véspera do salário");
    await add("expense", 70, "2026-11-05", "já é o mês novo");
  });

  afterAll(async () => {
    await db?.pool.end();
  });

  it("dia 1 (padrão): mês do calendário, como sempre foi", async () => {
    const r: any = await fin.financeSummary.run({ month: "2026-10" }, ctx);
    expect(r).toMatchObject({ expenses: "R$ 150,25", income: "R$ 3.000,00" });
    expect(r.period).toBeUndefined();
  });

  it("começando dia 5: outubro vai de 5/out a 4/nov", async () => {
    const set: any = await fin.monthStartTool.run({ day: 5 }, ctx);
    expect(set).toMatchObject({ ok: true, starts_on_day: 5, changed: true });
    expect(await fin.monthStartTool.run({ day: 31 }, ctx)).toMatchObject({ ok: false });
    const oct: any = await fin.financeSummary.run({ month: "2026-10" }, ctx);
    expect(oct).toMatchObject({ expenses: "R$ 80,25", income: "R$ 3.000,00", period: "5/out a 4/nov", month_starts_on_day: 5, previous_month_expenses: "R$ 100,00" });
    const nov: any = await fin.financeSummary.run({ month: "2026-11" }, ctx);
    expect(nov.expenses).toBe("R$ 70,00");
  });

  it("limite do mês conta o período dela", async () => {
    await fin.setBudget.run({ amount: 500 }, ctx);
    const rows = await fin.budgetStatus(ctx.user.id, tz, "2026-10");
    expect(rows[0]!.spent).toBeCloseTo(80.25);
  });

  it("categorias e relatório usam o mesmo período", async () => {
    const { listCategories } = await import("../src/categories.js");
    const cats = await listCategories(ctx.user.id, tz, "2026-10");
    expect(cats.find((c) => c.name === "Mercado")?.month_total).toBeCloseTo(80.25);
    const { buildFinanceReportHtml, loadReportData } = await import("../src/finance-report.js");
    const data = await loadReportData(ctx.user.id, "2026-10", tz);
    expect(data.start).toBe(5);
    expect(data.txs.map((t) => t.day)).toEqual(["2026-10-05", "2026-10-20", "2026-11-04"]);
    const html = buildFinanceReportHtml(data);
    expect(html).toContain("outubro de 2026 (5/out a 4/nov)");
  });

  it("o atalho 'quanto gastei no mês' e o cartão do chat seguem o mês atual dela", async () => {
    const { quickAnswer } = await import("../src/agent/quick.js");
    const q = await quickAnswer(ctx.user, false, { kind: "gasto_mes" } as any, tz);
    expect(q?.data).toHaveProperty("mes");
    const { financeMonthOf } = await import("../src/finance-month.js");
    expect((q?.data as any).mes).toBe(financeMonthOf(new Date(), tz, 5));
    await fin.monthStartTool.run({ day: 1 }, ctx);
  });
});
