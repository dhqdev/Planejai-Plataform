import { describe, expect, it } from "vitest";
import { nextLocalHour } from "../src/time.js";

describe("nextLocalHour", () => {
  it("dá as próximas 19h no fuso (hoje ou amanhã)", () => {
    // 15h em São Paulo (UTC-3) = 18h UTC
    expect(nextLocalHour(19, "America/Sao_Paulo", new Date("2026-10-20T18:00:00Z")).toISOString()).toBe("2026-10-20T22:00:00.000Z");
    // 19h30 em São Paulo: já passou, vai para amanhã
    expect(nextLocalHour(19, "America/Sao_Paulo", new Date("2026-10-20T22:30:00Z")).toISOString()).toBe("2026-10-21T22:00:00.000Z");
    // exatamente 19h: a próxima é amanhã
    expect(nextLocalHour(19, "America/Sao_Paulo", new Date("2026-10-20T22:00:00Z")).toISOString()).toBe("2026-10-21T22:00:00.000Z");
  });
});
