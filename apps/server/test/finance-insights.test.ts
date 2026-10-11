import { describe, expect, it } from "vitest";
import { analyzeFinance, recurringKey, type InsightTx } from "../src/finance-insights.js";

const tx = (day: string, amount: number, category: string, name: string, o: Partial<InsightTx> = {}): InsightTx => ({
  kind: "expense",
  amount,
  category,
  description: name,
  merchant: null,
  day,
  installments: null,
  ...o,
});

// três meses de histórico + outubro em andamento (hoje = dia 15)
const base: InsightTx[] = [];
for (const [i, m] of ["2026-07", "2026-08", "2026-09"].entries()) {
  base.push(tx(`${m}-05`, 1500, "Moradia", "Aluguel"));
  base.push(tx(`${m}-10`, 55.9, "Assinaturas", "Netflix"));
  base.push(tx(`${m}-12`, [280, 300, 320][i]!, "Alimentação", "Restaurante"));
  base.push(tx(`${m}-01`, 5000, "Salário", "Salário", { kind: "income" }));
}

describe("visão de economia do Financeiro", () => {
  it("nome da cobrança ignora acento, número e caixa", () => {
    expect(recurringKey({ merchant: "NETFLIX.COM 0923", description: null, category: "Assinaturas" })).toBe("netflix com");
    expect(recurringKey({ merchant: null, description: "Padaria São João", category: "Alimentação" })).toBe("padaria sao joao");
  });

  it("acha as cobranças que se repetem e projeta o que ainda vai cair", () => {
    const txs = [...base, tx("2026-10-05", 1500, "Moradia", "Aluguel"), tx("2026-10-02", 5000, "Salário", "Salário", { kind: "income" })];
    const a = analyzeFinance({ month: "2026-10", today: "2026-10-15", txs, bills: [{ kind: "expense", description: "Internet", amount: 99.9, paid: false }] });
    const names = a.recurring.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["Aluguel", "Netflix"]));
    expect(a.recurring.find((r) => r.name === "Netflix")).toMatchObject({ monthly: 55.9, yearly: 670.8, chargedThisMonth: false, kind: "assinatura" });
    // aluguel já caiu; Netflix (55,90) e a internet (99,90) ainda vão cair
    expect(a.projection?.pendingFixed).toBe(155.8);
    expect(a.projection!.expected).toBeGreaterThan(1500 + 155.8);
    expect(a.pace.days).toHaveLength(31);
    expect(a.pace.days[14]!.actual).toBe(1500);
    expect(a.pace.days[15]!.actual).toBeNull();
  });

  it("dica de corte com valor: categoria acima da média, até o mesmo dia do mês", () => {
    const txs = [...base, tx("2026-10-03", 400, "Alimentação", "Restaurante"), tx("2026-10-08", 350, "Alimentação", "Ifood")];
    const a = analyzeFinance({ month: "2026-10", today: "2026-10-15", txs });
    const alta = a.tips.find((t) => t.id === "alta:Alimentação");
    expect(alta?.saving).toBe(450); // 750 até o dia 15 contra 300 de média
    expect(a.changes[0]).toMatchObject({ category: "Alimentação", delta: 450 });
    expect(a.tips.find((t) => t.id === "assinaturas")?.saving).toBe(55.9);
    expect(a.potential).toBe(505.9);
  });

  it("muitas idas ao mesmo lugar e gastos pequenos viram dica, sem contar a mesma categoria duas vezes", () => {
    const txs: InsightTx[] = [];
    for (let d = 1; d <= 6; d++) txs.push(tx(`2026-09-${String(d * 4).padStart(2, "0")}`, 60, "Alimentação", "iFood"));
    for (let d = 1; d <= 10; d++) txs.push(tx(`2026-09-${String(d + 2).padStart(2, "0")}`, 12, "Lazer", `Café ${"abcdefghij"[d - 1]}lugar${d}`));
    const a = analyzeFinance({ month: "2026-09", today: "2026-10-15", txs });
    expect(a.projection).toBeNull();
    const ifood = a.tips.find((t) => t.id.startsWith("frequente:"));
    expect(ifood?.saving).toBe(120); // 2 pedidos a menos de 60
    expect(a.tips.find((t) => t.id === "pequenos")?.saving).toBe(60);
    expect(a.potential).toBe(180);
    expect(a.savings).toHaveLength(6);
  });

  it("sem lançamento nenhum não quebra e explica como começar", () => {
    const a = analyzeFinance({ month: "2026-10", today: "2026-10-15", txs: [] });
    expect(a.tips).toEqual([]);
    expect(a.potential).toBe(0);
    expect(a.headline).toContain("WhatsApp");
  });
});
