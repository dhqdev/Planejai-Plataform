import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Compras = busca comparada: Mercado Livre + Shopee juntos, sem banco (registro de integrações e API do Mercado Livre falsos). */
const creds: Record<string, Record<string, string> | null> = {};
vi.mock("../src/integrations/registry.js", () => ({
  getCredentials: async (id: string) => creds[id] ?? null,
  isConnected: async (id: string) => Boolean(creds[id]),
}));
const ml: Record<string, unknown> = {};
const calls: string[] = [];
vi.mock("../src/integrations/mercadolivre.js", () => ({
  MercadoLivreError: class extends Error {
    constructor(m: string, readonly status: number) {
      super(m);
    }
  },
  mercadolivreApi: async (path: string) => {
    calls.push(path);
    // a chave mais longa que casa ganha ("/products/MLB1/items" antes de "/products/MLB1")
    const key = Object.keys(ml)
      .sort((a, b) => b.length - a.length)
      .find((k) => path.startsWith(k));
    if (!key) throw new Error(`sem mock para ${path}`);
    return ml[key];
  },
}));

const { relevant, searchOffers } = await import("../src/shopping.js");
const { conflicts, parseWanted, variantQuestions } = await import("../src/variants.js");

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(creds)) delete creds[k];
  for (const k of Object.keys(ml)) delete ml[k];
  calls.length = 0;
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

describe("variação certa", () => {
  it("pergunta o que muda o produto antes de buscar, e só o que falta", () => {
    expect(variantQuestions("tênis Nike Revolution 7")).toEqual(["qual o número do calçado", "qual a cor"]);
    expect(variantQuestions("tênis Nike Revolution 7 42")).toEqual(["qual a cor"]);
    expect(variantQuestions("tênis Nike Revolution 7 42 preto")).toEqual([]);
    expect(variantQuestions("air fryer Mondial 4L")).toEqual(["qual a voltagem (110 ou 220)"]);
    expect(variantQuestions("air fryer Mondial 4L 220v")).toEqual([]);
    expect(variantQuestions("iPhone 15")).toEqual(["quanta memória (ex.: 128 GB)"]);
    expect(variantQuestions("capinha iPhone 15")).toEqual([]);
    expect(variantQuestions("camiseta Hering básica")).toEqual(["qual o tamanho (P, M, G...)", "qual a cor"]);
    expect(variantQuestions("fone JBL Tune 520BT")).toEqual([]);
    // respondeu (ou disse que tanto faz): busca
    expect(variantQuestions("tênis Nike Revolution 7", "tanto faz")).toEqual([]);
  });

  it("lê tamanho, cor, voltagem e memória do jeito que a pessoa escreve", () => {
    expect(parseWanted("42, preta", true)).toEqual({ size: "42", color: "preto" });
    expect(parseWanted("220 V", true)).toEqual({ voltage: "220" });
    expect(parseWanted("110v", true)).toEqual({ voltage: "127" });
    expect(parseWanted("128 GB azul", true)).toEqual({ capacity: "128gb", color: "azul" });
    expect(parseWanted("tamanho M", true)).toEqual({ size: "m" });
  });

  it("anúncio que diz outra voltagem ou memória não serve; bivolt serve para qualquer uma", () => {
    expect(conflicts({ voltage: "220" }, "Air Fryer Mondial 4L 127V Preta")).toBe(true);
    expect(conflicts({ voltage: "220" }, "Air Fryer Mondial 4L 220V")).toBe(false);
    expect(conflicts({ voltage: "220" }, "Air Fryer Mondial 4L Bivolt")).toBe(false);
    expect(conflicts({ voltage: "220" }, "Air Fryer Mondial 4L")).toBe(false);
    expect(conflicts({ capacity: "128gb" }, "Apple iPhone 15 (256 GB) - Preto")).toBe(true);
    expect(conflicts({ capacity: "128gb" }, "Xiaomi Redmi 13 128GB 6GB RAM")).toBe(false);
  });

  it("leva o link do Mercado Livre para a cor e o tamanho pedidos, com o preço dessa variação", async () => {
    creds.mercadolivre = { refresh_token: "x" };
    ml["/sites/MLB/search"] = {
      results: [{ title: "Tênis Nike Revolution 7 Branco", price: 299.9, permalink: "https://www.mercadolivre.com.br/p/MLB10" }],
    };
    const shoe = (id: string, name: string) => ({
      id,
      name,
      pickers: [
        { picker_id: "COLOR", picker_name: "Cor", products: [{ product_id: "MLB10", picker_label: "Branco" }, { product_id: "MLB20", picker_label: "Preto" }] },
        {
          picker_id: "SIZE",
          picker_name: "Tamanho",
          products: id === "MLB10" ? [{ product_id: "MLB10", picker_label: "BR 40" }] : [{ product_id: "MLB20", picker_label: "BR 40" }, { product_id: "MLB22", picker_label: "BR 42" }],
        },
      ],
    });
    ml["/products/MLB10"] = shoe("MLB10", "Tênis Nike Revolution 7 Branco 40");
    ml["/products/MLB20"] = shoe("MLB20", "Tênis Nike Revolution 7 Preto 40");
    ml["/products/MLB22"] = { ...shoe("MLB20", "Tênis Nike Revolution 7 Preto 42"), id: "MLB22", pictures: [{ url: "http://http2.mlstatic.com/p.jpg" }] };
    ml["/products/MLB22/items"] = { results: [{ price: 349.9, condition: "new", shipping: { free_shipping: true } }, { price: 289.9, condition: "used" }] };
    const r = await searchOffers("tênis Nike Revolution 7", { web: false, variant: "42, preto", condition: "new" });
    expect(r.offers).toHaveLength(1);
    expect(r.offers[0]).toMatchObject({
      link: "https://www.mercadolivre.com.br/p/MLB22",
      cents: 34_990,
      variant_ok: true,
      free_shipping: true,
      title: "Tênis Nike Revolution 7 Preto 42",
      image: "https://http2.mlstatic.com/p.jpg",
    });
    expect(r.offers[0]!.pick).toBeUndefined();
  });

  it("tira a oferta quando a loja não tem a variação, e a Shopee diz o que escolher na página", async () => {
    creds.mercadolivre = { refresh_token: "x" };
    creds.shopee = { app_id: "123", secret: "s3" };
    ml["/sites/MLB/search"] = { results: [{ title: "Tênis Nike Revolution 7", price: 299.9, permalink: "https://www.mercadolivre.com.br/p/MLB10" }] };
    ml["/products/MLB10"] = {
      id: "MLB10",
      name: "Tênis Nike Revolution 7",
      pickers: [{ picker_id: "SIZE", picker_name: "Tamanho", products: [{ product_id: "MLB10", picker_label: "BR 39" }, { product_id: "MLB11", picker_label: "BR 40" }] }],
    };
    vi.stubGlobal("fetch", async () =>
      json({ data: { productOfferV2: { nodes: [{ productName: "Tênis Nike Revolution 7 Masculino", priceMin: "279.90", offerLink: "https://s.shopee.com.br/t" }] } } }),
    );
    const r = await searchOffers("tênis Nike Revolution 7", { web: false, variant: "44" });
    expect(r.offers.map((o) => [o.store, o.pick, o.variant_ok])).toEqual([["Shopee", "tamanho 44", undefined]]);
  });

  it("corta voltagem errada e preço bom demais para ser verdade", async () => {
    creds.mercadolivre = { refresh_token: "x" };
    ml["/sites/MLB/search"] = {
      results: [
        { title: "Air Fryer Mondial 4L 127V", price: 289, permalink: "https://produto.mercadolivre.com.br/A" },
        { title: "Air Fryer Mondial 4L 220V", price: 309, permalink: "https://produto.mercadolivre.com.br/B" },
        { title: "Air Fryer Mondial 4L Bivolt", price: 329, permalink: "https://produto.mercadolivre.com.br/C" },
        { title: "Air Fryer Mondial 4L 220V Preta", price: 319, permalink: "https://produto.mercadolivre.com.br/D" },
        { title: "Air Fryer Mondial 4L 220V Oferta", price: 49, permalink: "https://produto.mercadolivre.com.br/E" },
      ],
    };
    const r = await searchOffers("air fryer Mondial 4L", { web: false, variant: "220V" });
    expect(r.offers.map((o) => o.cents)).toEqual([30_900, 31_900, 32_900]);
    // anúncio comum (sem /p/) não troca de variação: diz o que escolher, sem gastar chamada
    expect(r.offers[0]!.pick).toBe("220V");
    expect(calls.filter((c) => c.startsWith("/products"))).toEqual([]);
  });
});
