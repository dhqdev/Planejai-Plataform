import { describe, expect, it, vi } from "vitest";
import { convertCurrency } from "../src/agent/tools/finance.js";
import * as net from "../src/net.js";

describe("convert_currency tool", () => {
  it("converte USD para BRL usando a cotação da API", async () => {
    const safeFetchSpy = vi.spyOn(net, "safeFetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        USDBRL: {
          bid: "5.51",
          create_date: "2026-01-15 12:00:00",
        },
      }),
    } as any);

    const res = await convertCurrency.run({ amount: 50 }, {} as any);
    expect(safeFetchSpy).toHaveBeenCalledWith("https://economia.awesomeapi.com.br/json/last/USD-BRL");
    expect(res).toMatchObject({
      ok: true,
      original: "US$ 50.00",
      converted: "R$ 275,50",
      rate: 5.51,
      date: "2026-01-15 12:00:00",
    });
    safeFetchSpy.mockRestore();
  });

  it("avisa e não inventa valor quando a API externa falhar", async () => {
    const safeFetchSpy = vi.spyOn(net, "safeFetch").mockResolvedValueOnce({
      ok: false,
    } as any);

    const res = await convertCurrency.run({ amount: 100 }, {} as any);
    expect(res).toEqual({
      ok: false,
      error: "Não consegui pegar a cotação agora. Quer que eu tente de novo?",
    });
    safeFetchSpy.mockRestore();
  });

  it("avisa e não inventa valor quando bid for inválido", async () => {
    const safeFetchSpy = vi.spyOn(net, "safeFetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ USDBRL: { bid: "invalido" } }),
    } as any);

    const res = await convertCurrency.run({ amount: 100 }, {} as any);
    expect(res).toEqual({
      ok: false,
      error: "Não consegui pegar a cotação agora. Quer que eu tente de novo?",
    });
    safeFetchSpy.mockRestore();
  });
});
