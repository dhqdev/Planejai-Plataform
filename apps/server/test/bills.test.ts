import { describe, expect, it } from "vitest";
import { billStatus, dueDateIn, reminderText, type Bill } from "../src/bills.js";

const bill = (o: Partial<Bill>): Bill => ({
  id: o.id ?? "b1",
  user_id: "u",
  kind: "expense",
  description: "Aluguel",
  amount: "1500",
  category: "Moradia",
  due_day: 10,
  remind_days_before: 1,
  installments_left: null,
  active: true,
  last_paid_month: null,
  last_reminded_on: null,
  ...o,
});

describe("contas fixas", () => {
  it("dia 31 em fevereiro vira o último dia do mês", () => {
    expect(dueDateIn("2026-02", 31)).toBe("2026-02-28");
    expect(dueDateIn("2028-02", 30)).toBe("2028-02-29");
    expect(dueDateIn("2026-10", 5)).toBe("2026-10-05");
  });

  it("paga no mês: o próximo vencimento é o do mês que vem", () => {
    expect(billStatus(bill({}), "2026-10-08")).toMatchObject({ paid: false, days: 2, late: false });
    expect(billStatus(bill({ last_paid_month: "2026-10" }), "2026-10-08")).toMatchObject({ paid: true, due: "2026-11-10" });
    expect(billStatus(bill({ due_day: 5 }), "2026-10-08")).toMatchObject({ late: true, days: -3 });
  });

  it("lembra antes, no dia e no dia seguinte, numa mensagem só, e não repete no mesmo dia", () => {
    const bills = [
      bill({ id: "a", due_day: 9 }),
      bill({ id: "b", description: "Internet", amount: "120", due_day: 8 }),
      bill({ id: "c", description: "Luz", amount: null, due_day: 7 }),
      bill({ id: "d", description: "Salário", kind: "income", amount: "5000", due_day: 8 }),
      bill({ id: "e", description: "Academia", due_day: 20 }),
      bill({ id: "f", description: "Escola", due_day: 8, last_paid_month: "2026-10" }),
    ];
    const r = reminderText(bills, "2026-10-08")!;
    expect(r.ids.sort()).toEqual(["a", "b", "c", "d"]);
    expect(r.text).toContain("Amanhã vence Aluguel (R$ 1.500,00).");
    expect(r.text).toContain("Hoje vence Internet (R$ 120,00).");
    expect(r.text).toContain("Luz venceu ontem e ainda não marquei como paga.");
    expect(r.text).toContain("Hoje deve cair Salário (R$ 5.000,00).");
    expect(r.text).toMatch(/paguei/);
    expect(reminderText(bills.map((b) => ({ ...b, last_reminded_on: "2026-10-08" })), "2026-10-08")).toBeNull();
  });
});
