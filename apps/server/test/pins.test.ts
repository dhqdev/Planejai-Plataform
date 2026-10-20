import { describe, expect, it } from "vitest";
import { isShoppingList, LIST_STALE_HOURS, staleListNote } from "../src/agent/pins.js";

const H = 3_600_000;

describe("lista de compras nova depois de um tempo", () => {
  it("reconhece o balão da lista", () => {
    expect(isShoppingList("🛒 Lista do mercado: arroz")).toBe(true);
    expect(isShoppingList("*Lista de compras*\n• arroz")).toBe(true);
    expect(isShoppingList("📊 Resumo do mês: R$ 1.200,00")).toBe(false);
  });

  it(`só avisa com a lista parada há mais de ${LIST_STALE_HOURS}h e quando ela fala de comprar`, () => {
    const now = Date.now();
    expect(staleListNote(null, now, "preciso comprar leite")).toBeNull();
    expect(staleListNote(now - 2 * H, now, "preciso comprar leite")).toBeNull();
    expect(staleListNote(now - 13 * H, now, "que horas é o dentista?")).toBeNull();
    expect(staleListNote(now - 13 * H, now, "preciso comprar leite")).toContain("há 13 horas");
    expect(staleListNote(now - 30 * H, now, "acabou o café")).toContain("há 1 dia");
    expect(staleListNote(now - 80 * H, now, "coloca pão na lista")).toContain("há 3 dias");
  });
});
