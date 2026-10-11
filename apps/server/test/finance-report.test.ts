import { describe, expect, it } from "vitest";
import { buildFinanceReportHtml, isSendDay, reportMonthFor, type ReportData } from "../src/finance-report.js";

const base: ReportData = {
  name: "Ana",
  month: "2026-09",
  today: "2026-10-05",
  txs: [
    { day: "2026-09-05", kind: "income", amount: 5000, category: "Salário", description: "Salário", merchant: null, card_name: null, installment: null, installments: null },
    { day: "2026-09-05", kind: "expense", amount: 1500, category: "Moradia", description: "Aluguel", merchant: null, card_name: null, installment: null, installments: null },
    { day: "2026-09-12", kind: "expense", amount: 320.5, category: "Mercado", description: null, merchant: "Pão de Açúcar", card_name: "Nubank", installment: 1, installments: 3 },
    { day: "2026-09-13", kind: "expense", amount: 80, category: "Lazer", description: "Cinema <script>", merchant: null, card_name: null, installment: null, installments: null },
  ],
  months: [
    { month: "2026-04", income: 0, expenses: 0 },
    { month: "2026-05", income: 0, expenses: 0 },
    { month: "2026-06", income: 0, expenses: 0 },
    { month: "2026-07", income: 0, expenses: 0 },
    { month: "2026-08", income: 5000, expenses: 1700 },
    { month: "2026-09", income: 5000, expenses: 1900.5 },
  ],
  prevByCategory: [{ category: "Moradia", total: 1500 }, { category: "Lazer", total: 200 }],
  budgets: [{ category: "Lazer", limit: 50, spent: 80 }],
  bills: [{ description: "Aluguel", kind: "expense", amount: 1500, due_day: 5, paid: true }],
  cards: [{ name: "Nubank", last4: "1234", limit: 3000, used: 961.5, invoice: 320.5, invoiceStatus: "paga", due: "2026-10-10", futureInstallments: 641 }],
};

describe("relatório de finanças em PDF", () => {
  it("monta resumo, tabelas, gráficos e explicações com os números certos", () => {
    const html = buildFinanceReportHtml(base);
    expect(html).toContain("Setembro de 2026");
    expect(html).toContain("R$ 1.900,50"); // saídas
    expect(html).toContain("R$ 3.099,50"); // saldo
    expect(html).toContain("guardou <b>62%</b>");
    expect(html).toContain("<svg"); // gráficos
    expect(html).toContain("Todos os lançamentos");
    expect(html).toContain("Cartão Nubank 1/3");
    expect(html).toContain("O limite de Lazer");
    expect(html).toContain("R$ 641,00 em parcelas");
    // texto da pessoa vai escapado
    expect(html).not.toContain("<script>");
    expect(html).toContain("Cinema &lt;script&gt;");
  });

  it("mês sem lançamento não quebra", () => {
    const html = buildFinanceReportHtml({ ...base, txs: [], budgets: [], bills: [], cards: [], prevByCategory: [] });
    expect(html).toContain("Não teve nenhum lançamento");
  });

  it("dia do envio: 31 vira o último dia do mês e o relatório é do mês anterior", () => {
    expect(isSendDay(5, "2026-10-05")).toBe(true);
    expect(isSendDay(5, "2026-10-06")).toBe(false);
    expect(isSendDay(31, "2026-02-28")).toBe(true);
    expect(isSendDay(30, "2026-02-28")).toBe(true);
    expect(isSendDay(31, "2026-03-30")).toBe(false);
    expect(reportMonthFor("2026-01-05")).toBe("2025-12");
  });
});
