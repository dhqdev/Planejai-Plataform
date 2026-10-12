import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Compras = busca comparada: Mercado Livre + Shopee juntos, sem banco (registro de integrações e API do Mercado Livre falsos). */
const creds: Record<string, Record<string, string> | null> = {};
vi.mock("../src/integrations/registry.js", () => ({
  getCredentials: async (id: string) => creds[id] ?? null,
  isConnected: async (id: string) => Boolean(creds[id]),
}));
const ml: Record<string, unknown> = {};
vi.mock("../src/integrations/mercadolivre.js", () => ({
  MercadoLivreError: class extends Error {
    constructor(m: string, readonly status: number) {
      super(m);
    }
  },
  mercadolivreApi: async (path: string) => {
    const key = Object.keys(ml).find((k) => path.startsWith(k));
    if (!key) throw new Error(`sem mock para ${path}`);
    return ml[key];
  },
}));

const { relevant, searchOffers } = await import("../src/shopping.js");

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(creds)) delete creds[k];
  for (const k of Object.keys(ml)) delete ml[k];
});

describe("busca comparada", () => {
  it("fica só com o que bate com o pedido (sem capinha de quem pediu o fone)", () => {
    expect(relevant("fone JBL Tune 520BT", "Fone De Ouvido JBL Tune 520BT Bluetooth Preto")).toBe(true);
    expect(relevant("fone JBL Tune 520BT", "Fone Sony WH-CH520")).toBe(false);
    expect(relevant("fone JBL", "Capa Protetora Para Fone JBL Tune")).toBe(false);
    expect(relevant("capa fone JBL", "Capa Protetora Para Fone JBL Tune")).toBe(true);
    expect(relevant("air fryer mondial barata", "Fritadeira Air Fryer Mondial 4L AFN-40")).toBe(true);
  });

  it("junta Mercado Livre e Shopee em centavos, do mais barato, e assina o pedido da Shopee", async () => {
    creds.mercadolivre = { refresh_token: "x" };
    creds.shopee = { app_id: "123", secret: "s3" };
    ml["/sites/MLB/search"] = {
      results: [
        { title: "Fone JBL Tune 520BT Azul", price: 229.9, permalink: "https://www.mercadolivre.com.br/p/MLB1", thumbnail: "http://http2.mlstatic.com/a.jpg", shipping: { free_shipping: true } },
        { title: "Capa para fone JBL Tune", price: 19.9, permalink: "https://www.mercadolivre.com.br/p/MLB2" },
      ],
    };
    let sent: { auth: string; body: string } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(String(url)).toBe("https://open-api.affiliate.shopee.com.br/graphql");
      sent = { auth: String((init.headers as Record<string, string>).Authorization), body: String(init.body) };
      return json({
        data: {
          productOfferV2: {
            nodes: [
              { itemId: 1, shopId: 2, productName: "Fone JBL Tune 520BT Original", priceMin: "199.90", priceMax: "199.90", priceDiscountRate: 20, offerLink: "https://s.shopee.com.br/abc", shopName: "JBL Oficial", ratingStar: "4.8", sales: 1200 },
            ],
          },
        },
      });
    });
    const r = await searchOffers("fone JBL Tune 520BT", { web: false });
    expect(r.stores).toEqual(["Mercado Livre", "Shopee"]);
    expect(r.offers.map((o) => [o.store, o.cents])).toEqual([
      ["Shopee", 19_990],
      ["Mercado Livre", 22_990],
    ]);
    expect(r.offers[0]).toMatchObject({ old_cents: 24_988, link: "https://s.shopee.com.br/abc", seller: "JBL Oficial" });
    expect(r.offers[1]).toMatchObject({ free_shipping: true, image: "https://http2.mlstatic.com/a.jpg" });
    const m = sent!.auth.match(/^SHA256 Credential=123, Timestamp=(\d+), Signature=([0-9a-f]{64})$/);
    expect(m).not.toBeNull();
    expect(m![2]).toBe(createHash("sha256").update(`123${m![1]}${sent!.body}s3`).digest("hex"));
    expect(JSON.parse(sent!.body).query).toContain('productOfferV2(keyword: "fone JBL Tune 520BT"');
  });

  it("loja que falha não derruba a busca, e o teto de preço vale", async () => {
    creds.mercadolivre = { refresh_token: "x" };
    creds.shopee = { app_id: "123", secret: "s3" };
    ml["/sites/MLB/search"] = {
      results: [
        { title: "Air Fryer Mondial 4L", price: 299, permalink: "https://www.mercadolivre.com.br/p/A" },
        { title: "Air Fryer Mondial 5L", price: 459, permalink: "https://www.mercadolivre.com.br/p/B" },
      ],
    };
    vi.stubGlobal("fetch", async () => json({ errors: [{ message: "Invalid Signature" }] }));
    const r = await searchOffers("air fryer mondial", { web: false, maxCents: 40_000 });
    expect(r.failed).toEqual(["Shopee"]);
    expect(r.offers.map((o) => o.cents)).toEqual([29_900]);
  });

  it("sem loja conectada, cai na busca web", async () => {
    creds.tavily = { api_key: "t" };
    vi.stubGlobal("fetch", async () => json({ answer: "Em torno de R$ 200", results: [{ title: "Fone JBL", url: "https://loja.example/fone", content: "R$ 199" }] }));
    const r = await searchOffers("fone JBL", { web: "keys" });
    expect(r.offers).toEqual([]);
    expect(r.web?.[0]?.url).toBe("https://loja.example/fone");
    expect(r.web_answer).toContain("R$ 200");
  });
});
