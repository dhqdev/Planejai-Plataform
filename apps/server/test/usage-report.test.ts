import { describe, expect, it } from "vitest";
import { buildUsageMessage } from "../src/usage-report.js";

describe("resumo diário de gasto de IA", () => {
  it("lista quem usou, o sistema e o saldo", () => {
    const t = buildUsageMessage({
      day: "2026-10-18",
      totalUsd: 1.2345,
      totalTokens: 123456,
      calls: 80,
      people: [
        { name: "David", costUsd: 0.9, tokens: 100000 },
        { name: "Ana", costUsd: 0.2, tokens: 20000 },
      ],
      systemUsd: 0.1345,
      remainingUsd: 37.5,
    });
    expect(t).toContain("18/10/2026");
    expect(t).toContain("US$ 1,23");
    expect(t).toContain("David: US$ 0,9000");
    expect(t).toContain("Sistema");
    expect(t).toContain("US$ 37,50");
  });
  it("dia sem uso avisa", () => {
    const t = buildUsageMessage({ day: "2026-10-18", totalUsd: 0, totalTokens: 0, calls: 0, people: [], systemUsd: 0, remainingUsd: null });
    expect(t).toContain("Ninguém usou");
  });
});
