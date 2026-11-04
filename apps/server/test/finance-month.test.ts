import { describe, expect, it } from "vitest";
import { clampStart, financeMonthOf, monthSql, periodOf, periodText, shiftMonth } from "../src/finance-month.js";
import { reportMonthFor } from "../src/finance-report.js";
import { MONTH_START_WHEN } from "../src/agent/team.js";

const at = (iso: string) => new Date(`${iso}T15:00:00Z`); // meio do dia em São Paulo

describe("mês financeiro (começa no dia que a pessoa escolheu)", () => {
  it("dia 1 é o mês do calendário", () => {
    expect(financeMonthOf(at("2026-11-01"), "America/Sao_Paulo", 1)).toBe("2026-11");
    expect(financeMonthOf(at("2026-11-30"), "America/Sao_Paulo", 1)).toBe("2026-11");
    expect(monthSql("t.occurred_at", "$2", 1)).toBe("to_char(t.occurred_at AT TIME ZONE $2, 'YYYY-MM')");
  });

  it("começando dia 5: 4/nov ainda é outubro, 5/nov abre novembro, 4/dez fecha", () => {
    const tz = "America/Sao_Paulo";
    expect(financeMonthOf(at("2026-11-04"), tz, 5)).toBe("2026-10");
    expect(financeMonthOf(at("2026-11-05"), tz, 5)).toBe("2026-11");
    expect(financeMonthOf(at("2026-12-04"), tz, 5)).toBe("2026-11");
    expect(financeMonthOf(at("2027-01-04"), tz, 5)).toBe("2026-12");
    expect(periodOf("2026-11", 5)).toEqual({ start: 5, from: "2026-11-05", to: "2026-12-04", days: 30 });
    expect(periodText("2026-11", 5)).toBe("5/nov a 4/dez");
    expect(monthSql("occurred_at", "$2", 5)).toContain("interval '4 days'");
  });

  it("dia 28 atravessa fevereiro sem perder nem repetir dia", () => {
    expect(periodOf("2027-01", 28)).toMatchObject({ from: "2027-01-28", to: "2027-02-27", days: 31 });
    expect(periodOf("2027-02", 28)).toMatchObject({ from: "2027-02-28", to: "2027-03-27", days: 28 });
    expect(financeMonthOf(at("2027-02-27"), "UTC", 28)).toBe("2027-01");
    expect(financeMonthOf(at("2027-02-28"), "UTC", 28)).toBe("2027-02");
    expect(financeMonthOf(at("2027-03-01"), "UTC", 28)).toBe("2027-02");
  });

  it("dia fora de 1..28 vira 1 (e nunca entra cru no SQL)", () => {
    expect(clampStart(0)).toBe(1);
    expect(clampStart(31)).toBe(1);
    expect(clampStart("5; drop table users")).toBe(1);
    expect(clampStart("12")).toBe(12);
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });

  it("relatório agendado cobre o mês financeiro que fechou", () => {
    // dia 5/dez: o período 5/nov a 4/dez acabou ontem
    expect(reportMonthFor("2026-12-05", 5)).toBe("2026-11");
    expect(reportMonthFor("2026-12-04", 5)).toBe("2026-10");
    expect(reportMonthFor("2026-12-06", 5)).toBe("2026-11");
    expect(reportMonthFor("2027-01-05")).toBe("2026-12");
  });

  it("o agente reconhece quando a pessoa fala do dia do mês", () => {
    expect(MONTH_START_WHEN.test("meu mês começa dia 5")).toBe(true);
    expect(MONTH_START_WHEN.test("recebo todo dia 5")).toBe(true);
    expect(MONTH_START_WHEN.test("meu mes fecha no dia 4")).toBe(true);
    expect(MONTH_START_WHEN.test("gastei 30 no mercado")).toBe(false);
  });
});
