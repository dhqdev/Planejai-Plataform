import { afterEach, describe, expect, it, vi } from "vitest";

describe("saldo do OpenRouter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function load(fetchImpl: (url: string) => Promise<Response>) {
    process.env.OPENROUTER_API_KEY = "sk-teste";
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn((url: string) => fetchImpl(String(url))));
    return (await import("../src/llm/balance.js")).openRouterAccount;
  }
  const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }));

  it("saldo = créditos comprados - usados, e traz o uso da chave", async () => {
    const account = await load((url) =>
      url.endsWith("/credits") ? json({ total_credits: 50, total_usage: 12.5 }) : json({ usage: 12.4, usage_daily: 0.3, usage_monthly: 6.2, limit: null, limit_remaining: null }),
    );
    const a = await account();
    expect(a.remainingUsd).toBeCloseTo(37.5);
    expect(a.keyMonthUsd).toBe(6.2);
    expect(a.error).toBeUndefined();
  });

  it("sem /credits cai no limite restante da chave", async () => {
    const account = await load((url) => (url.endsWith("/credits") ? Promise.resolve(new Response("{}", { status: 403 })) : json({ usage: 1, limit: 10, limit_remaining: 9 })));
    const a = await account();
    expect(a.remainingUsd).toBe(9);
  });

  it("sem saldo informado avisa em vez de inventar", async () => {
    const account = await load((url) => (url.endsWith("/credits") ? Promise.resolve(new Response("{}", { status: 403 })) : json({ usage: 1 })));
    const a = await account();
    expect(a.remainingUsd).toBeNull();
    expect(a.error).toMatch(/saldo/);
  });
});
