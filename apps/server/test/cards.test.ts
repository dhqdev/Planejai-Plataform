import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMonths, cardReminderLines, invoiceDates, invoiceMonthFor, invoiceStatus, nextDueMonth, shiftDate, type Card } from "../src/cards.js";

const card = (o: Partial<Card> = {}): Card => ({
  id: "c1",
  user_id: "u",
  name: "Nubank",
  brand: null,
  last4: "1234",
  limit_amount: 5000,
  closing_day: 3,
  due_day: 10,
  color: "roxo",
  remind_days_before: 3,
  active: true,
  last_reminded_on: null,
  ...o,
});

describe("cartões: ciclo da fatura", () => {
  it("compra antes do fechamento cai na fatura do mês; no dia do fechamento já vai para a próxima", () => {
    const c = card();
    expect(invoiceMonthFor(c, "2026-10-02")).toBe("2026-10");
    expect(invoiceMonthFor(c, "2026-10-03")).toBe("2026-11");
    expect(invoiceMonthFor(c, "2026-10-20")).toBe("2026-11");
    expect(invoiceDates(c, "2026-11")).toEqual({ closing: "2026-11-03", due: "2026-11-10" });
  });

  it("vencimento antes do fechamento: fecha num mês e vence no seguinte", () => {
    const c = card({ closing_day: 25, due_day: 5 });
    expect(invoiceMonthFor(c, "2026-10-24")).toBe("2026-11");
    expect(invoiceMonthFor(c, "2026-10-25")).toBe("2026-12");
    expect(invoiceDates(c, "2026-11")).toEqual({ closing: "2026-10-25", due: "2026-11-05" });
    expect(invoiceMonthFor(c, "2026-12-28")).toBe("2027-02");
  });

  it("dia 31 vira o último dia em meses curtos, e parcela não pula mês", () => {
    const c = card({ closing_day: 31, due_day: 8 });
    expect(invoiceDates(c, "2026-03")).toEqual({ closing: "2026-02-28", due: "2026-03-08" });
    expect(shiftDate(new Date("2026-01-31T15:00:00Z"), 1).toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(shiftDate(new Date("2026-01-31T15:00:00Z"), 2).toISOString().slice(0, 10)).toBe("2026-03-31");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
  });

  it("próxima fatura e situação: aberta, fechada, atrasada, paga, futura", () => {
    const c = card();
    expect(nextDueMonth(c, "2026-10-08")).toBe("2026-10");
    expect(nextDueMonth(c, "2026-10-11")).toBe("2026-11");
    expect(invoiceStatus(c, "2026-10", "2026-10-08", 300, false)).toBe("fechada");
    expect(invoiceStatus(c, "2026-10", "2026-10-11", 300, false)).toBe("atrasada");
    expect(invoiceStatus(c, "2026-10", "2026-10-11", 300, true)).toBe("paga");
    expect(invoiceStatus(c, "2026-10", "2026-10-11", 0, false)).toBe("zerada");
    expect(invoiceStatus(c, "2026-11", "2026-10-08", 90, false)).toBe("aberta");
    expect(invoiceStatus(c, "2026-12", "2026-10-08", 90, false)).toBe("futura");
  });

  it("lembra quando fecha, N dias antes, no dia e no dia seguinte; paga ou zerada não lembra", () => {
    const c = card();
    const t = new Map([["2026-10", { total: 450.5 }], ["2026-11", { total: 90 }]]);
    expect(cardReminderLines(c, "2026-10-03", t, new Set())).toEqual(["A fatura do Nubank fechou hoje em R$ 450,50 e vence dia 10/10."]);
    expect(cardReminderLines(c, "2026-10-07", t, new Set())).toEqual(["Dia 10/10 vence a fatura do Nubank: R$ 450,50."]);
    expect(cardReminderLines(card({ remind_days_before: 1 }), "2026-10-09", t, new Set())).toEqual(["Amanhã vence a fatura do Nubank: R$ 450,50."]);
    expect(cardReminderLines(c, "2026-10-10", t, new Set())).toEqual(["Hoje vence a fatura do Nubank: R$ 450,50."]);
    expect(cardReminderLines(c, "2026-10-11", t, new Set())).toEqual(["A fatura do Nubank (R$ 450,50) venceu ontem e ainda não marquei como paga."]);
    expect(cardReminderLines(c, "2026-10-10", t, new Set(["2026-10"]))).toEqual([]);
    expect(cardReminderLines(c, "2026-10-05", t, new Set())).toEqual([]);
    expect(cardReminderLines(card({ last_reminded_on: "2026-10-10" }), "2026-10-10", t, new Set())).toEqual([]);
  });
});

/** Cartão ponta a ponta no Postgres: cadastro, compra à vista e parcelada, fatura, limite, pagar e painel. */
const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("cartões (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let user: any;
  let ctx: any;

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    const { upsertUser } = await import("../src/ingest.js");
    user = await upsertUser("5519933334444", "Bia");
    await db.query("UPDATE users SET status = 'active' WHERE id = $1", [user.id]);
    ctx = { user, timezone: "America/Sao_Paulo" };
  });

  afterAll(async () => {
    await db?.pool.end();
  });

  it("cadastra só o necessário e recusa o número inteiro", async () => {
    const { cardSave } = await import("../src/agent/tools/cards.js");
    const bad: any = await cardSave.run({ name: "Inter", last4: "5162 3344 1234 9876", closing_day: 1, due_day: 8 }, ctx).catch((e: Error) => ({ error: e.message }));
    expect(bad.error).toMatch(/4 últimos/);
    const ok: any = await cardSave.run({ name: "Nubank", last4: "1234", limit: 2000, closing_day: 3, due_day: 10 }, ctx);
    expect(ok).toMatchObject({ ok: true, created: "Nubank", limit: "R$ 2.000,00" });
  });

  it("compra à vista e parcelada no cartão caem nas faturas certas, e a fatura soma no centavo", async () => {
    const { addTransaction } = await import("../src/agent/tools/finance.js");
    const avista: any = await addTransaction.run({ kind: "expense", amount: 30, description: "Almoço", card: "nubank", date: "2026-10-02T12:00" }, ctx);
    expect(avista).toMatchObject({ ok: true, card: "Nubank" });
    expect(avista.first_invoice).toContain("outubro/2026");
    const parc: any = await addTransaction.run({ kind: "expense", amount: 1000, description: "Geladeira", installments: 3, card: "final 1234", date: "2026-10-05T10:00" }, ctx);
    expect(parc.installment_values).toEqual(["R$ 333,34", "R$ 333,33", "R$ 333,33"]);
    expect(parc.first_invoice).toContain("novembro/2026");
    expect(parc.last_invoice).toBe("janeiro/2027");
    const rows = await db.many("SELECT invoice_month, amount, installment, installments FROM transactions WHERE user_id = $1 AND description LIKE 'Geladeira%' ORDER BY invoice_month", [user.id]);
    expect(rows.map((r) => r.invoice_month)).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(rows.map((r) => r.installment)).toEqual([1, 2, 3]);

    const missing: any = await addTransaction.run({ kind: "expense", amount: 10, card: "Itaú" }, ctx);
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("Nubank (final 1234)");

    const { listCards, invoiceItems, getCard } = await import("../src/cards.js");
    const [c] = await listCards(user.id);
    expect(c!.used).toBe(1030);
    expect(c!.available).toBe(970);
    expect(c!.invoices.find((i) => i.month === "2026-11")?.total).toBe(333.34);
    expect(c!.installments[0]).toMatchObject({ description: "Geladeira", installments: 3, left: 3, left_amount: 1000 });
    const { items } = await invoiceItems(user.id, (await getCard(user.id, c!.id))!, "2026-10");
    expect(items.map((i) => Number(i.amount))).toEqual([30]);
  });

  it("paguei a fatura marca como paga sem lançar gasto e libera o limite", async () => {
    const { cardInvoicePay, cardInvoice } = await import("../src/agent/tools/cards.js");
    const before = await db.one("SELECT COUNT(*)::int AS n FROM transactions WHERE user_id = $1", [user.id]);
    const r: any = await cardInvoicePay.run({ card: "Nubank", month: "2026-10" }, ctx);
    expect(r).toMatchObject({ ok: true, card: "Nubank" });
    expect(r.invoice.status).toBe("paga");
    const after = await db.one("SELECT COUNT(*)::int AS n FROM transactions WHERE user_id = $1", [user.id]);
    expect(after.n).toBe(before.n);
    const all: any = await cardInvoice.run({}, ctx);
    expect(all.cards[0].available).toBe("R$ 1.000,00");
    const det: any = await cardInvoice.run({ card: "nubank", month: "2026-12" }, ctx);
    expect(det.invoice.total).toBe("R$ 333,33");
    expect(det.items[0].what).toBe("Geladeira (2/3)");
  });

  it("mudar o fechamento recalcula as faturas abertas; trocar o lançamento de cartão também", async () => {
    const { cardSave } = await import("../src/agent/tools/cards.js");
    // fechamento dia 6: a geladeira (dia 5) passa a começar em outubro; só as faturas não pagas são recalculadas
    await cardSave.run({ card: "Nubank", closing_day: 6, due_day: 13 }, ctx);
    const rows = await db.many("SELECT invoice_month FROM transactions WHERE user_id = $1 AND description LIKE 'Geladeira%' ORDER BY installment", [user.id]);
    expect(rows.map((r) => r.invoice_month)).toEqual(["2026-10", "2026-11", "2026-12"]);
    const { updateTransaction } = await import("../src/agent/tools/finance.js");
    const tx = await db.one("SELECT id FROM transactions WHERE user_id = $1 AND description = 'Almoço'", [user.id]);
    const u: any = await updateTransaction.run({ ids: [tx.id], card: "nenhum" }, ctx);
    expect(u.card).toBe("nenhum");
    expect(await db.one("SELECT card_id, invoice_month FROM transactions WHERE id = $1", [tx.id])).toEqual({ card_id: null, invoice_month: null });
  });

  it("remover cartão pede o sim", async () => {
    const { cardDelete } = await import("../src/agent/tools/cards.js");
    const conv = await (await import("../src/ingest.js")).upsertConversation(user.id, "playground", "cartao-del");
    const r: any = await cardDelete.run({ card: "Nubank" }, { ...ctx, agent: "financeiro", conversation: conv, toolCall: { name: "card_delete", args: { card: "Nubank" } } });
    expect(r.ok).not.toBe(true);
    expect((await db.one("SELECT active FROM cards WHERE user_id = $1", [user.id])).active).toBe(true);
  });
});
