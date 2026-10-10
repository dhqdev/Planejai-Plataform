import { afterEach, describe, expect, it, vi } from "vitest";

/** Lugares perto sem navegador (Google Places ou OpenStreetMap) e as travas do navegador. Sem banco: o registro de integrações é falso. */
const creds: Record<string, Record<string, string> | null> = {};
vi.mock("../src/integrations/registry.js", () => ({
  getCredentials: async (id: string) => creds[id] ?? null,
  isConnected: async (id: string) => Boolean(creds[id]),
}));

const { distanceKm, nearbyPlaces } = await import("../src/agent/tools/places.js");
const { isMapsUrl, browserOpen, mapRoute, MAX_MAP_PRINTS } = await import("../src/agent/tools/research.js");
const { Guard } = await import("../src/agent/guard.js");
const { partialReport, needsChrome, ASK_BUDGET_MS } = await import("../src/agent/collab.js");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(creds)) delete creds[k];
});

describe("places_nearby", () => {
  it("calcula distância em linha reta", () => {
    expect(distanceKm({ lat: -22.9, lng: -47.06 }, { lat: -22.9, lng: -47.06 })).toBe(0);
    expect(distanceKm({ lat: -22.9, lng: -47.06 }, { lat: -22.91, lng: -47.06 })).toBeCloseTo(1.1, 1);
  });

  it("sem chave do Google usa o OpenStreetMap e devolve só o mais perto", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const q = new URL(url).searchParams.get("q");
        if (q?.startsWith("Rua")) return json([{ lat: "-22.9000", lon: "-47.0600", display_name: "Rua X, Campinas" }]);
        return json([
          { lat: "-22.9200", lon: "-47.0600", name: "Pet Longe", address: { road: "Av. B", city: "Campinas" }, extratags: {} },
          { lat: "-22.9030", lon: "-47.0600", name: "PetCamp", address: { road: "Av. Baden Powell", house_number: "1929", city: "Campinas" }, extratags: { phone: "+55 19 3333-4444" } },
        ]);
      }),
    );
    const r: any = await nearbyPlaces("petshop", "Rua X, 460, Campinas");
    expect(r.source).toBe("openstreetmap");
    expect(r.places).toHaveLength(1);
    expect(r.places[0]).toMatchObject({ name: "PetCamp", phone: "+55 19 3333-4444", address: "Av. Baden Powell, 1929, Campinas" });
    expect(r.places[0].maps).toContain("google.com/maps");
    // "petshop" vira "pet shop", que o OpenStreetMap entende (shop=pet)
    expect(urls.some((u) => new URL(u).searchParams.get("q") === "pet shop")).toBe(true);
    expect(urls.every((u) => u.startsWith("https://nominatim.openstreetmap.org/"))).toBe(true);
  }, 15_000);

  it("com a chave do Google ordena por distância e traz telefone", async () => {
    creds.google_maps = { api_key: "k" };
    const bodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: any) => {
        const b = JSON.parse(init.body);
        bodies.push(b);
        if (b.maxResultCount === 1) return json({ places: [{ location: { latitude: -22.9, longitude: -47.06 }, formattedAddress: "Rua X, 460" }] });
        return json({
          places: [
            { displayName: { text: "Longe" }, formattedAddress: "Av. Z", location: { latitude: -22.95, longitude: -47.06 } },
            { displayName: { text: "PetCamp" }, formattedAddress: "Av. Baden Powell, 1929", location: { latitude: -22.905, longitude: -47.06 }, nationalPhoneNumber: "(19) 3333-4444", currentOpeningHours: { openNow: true } },
          ],
        });
      }),
    );
    const r: any = await nearbyPlaces("petshop", "Rua X, 460", { limit: 2 });
    expect(r.source).toBe("google");
    expect(r.places.map((p: any) => p.name)).toEqual(["PetCamp", "Longe"]);
    expect(r.places[0]).toMatchObject({ phone: "(19) 3333-4444", open_now: true });
    expect(bodies[1].rankPreference).toBe("DISTANCE");
  });

  it("endereço que não existe vira erro claro", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([])));
    const r: any = await nearbyPlaces("petshop", "lugar nenhum");
    expect(r.error).toMatch(/Não achei o endereço/);
  });
});

describe("navegador só quando precisa", () => {
  const room = () => ({ usage: { browserOpens: 0, browserActions: 0, mapPrints: 0 } });

  it("reconhece links do Google Maps", () => {
    expect(isMapsUrl("https://www.google.com/maps/search/pet+shop")).toBe(true);
    expect(isMapsUrl("https://maps.app.goo.gl/abc")).toBe(true);
    expect(isMapsUrl("https://www.google.com.br/maps/place/X")).toBe(true);
    expect(isMapsUrl("https://www.google.com/search?q=maps")).toBe(false);
    expect(isMapsUrl("https://ingresso.com")).toBe(false);
  });

  it("não abre o Google Maps no navegador nem passa do limite de aberturas", async () => {
    const ctx: any = { room: room() };
    const r: any = await browserOpen.run({ url: "https://www.google.com/maps/search/petshop" }, ctx);
    expect(r.error).toMatch(/places_nearby/);
    ctx.room.usage.browserOpens = 2;
    const r2: any = await browserOpen.run({ url: "https://ingresso.com" }, ctx);
    expect(r2.error).toMatch(/já foi aberto/);
  });

  it("depois de alguns mapas manda só o link", async () => {
    const ctx: any = { room: { usage: { browserOpens: 0, browserActions: 0, mapPrints: MAX_MAP_PRINTS } } };
    const r: any = await mapRoute.run({ destination: "PetCamp, Campinas", origin: "Rua X" }, ctx);
    expect(r.media_id).toBeUndefined();
    expect(r.link).toContain("google.com/maps/dir");
  });
});

describe("prazo do especialista", () => {
  it("para antes da execução e divide o contador de ações", async () => {
    const g = new Guard({ maxExecutionMinutes: 8, maxToolCalls: 10 });
    const sub = g.sub(90_000);
    expect(g.deadline - sub.deadline).toBeGreaterThanOrEqual(89_000);
    sub.toolCalls++;
    expect(g.toolCalls).toBe(1);
    g.dispose();
    sub.dispose();
  });

  it("cada pedido tem teto próprio (pesquisa não leva 4 minutos)", () => {
    const g = new Guard({ maxExecutionMinutes: 8, maxToolCalls: 10 });
    const sub = g.sub(90_000, ASK_BUDGET_MS.pesquisador);
    expect(sub.deadline - Date.now()).toBeLessThanOrEqual(ASK_BUDGET_MS.pesquisador! + 5);
    // fecha a resposta perto do fim da janela dele, não 45 s antes
    expect(sub.wrapUp).toBe(false);
    g.dispose();
    sub.dispose();
  });

  it("navegador só quando pediram para ver, printar ou gravar (compras sempre)", () => {
    const pesq = { id: "pesquisador" };
    expect(needsChrome(pesq, "me manda uns links do Fastback barato")).toBe(false);
    expect(needsChrome(pesq, "quais filmes passam amanhã às 20h?")).toBe(false);
    expect(needsChrome(pesq, "tira um print da programação")).toBe(true);
    expect(needsChrome(pesq, undefined, "grava a tela entrando no site")).toBe(true);
    expect(needsChrome({ id: "compras" }, "compra o tênis")).toBe(true);
  });

  it("cai junto quando a execução cai", async () => {
    const g = new Guard({ maxExecutionMinutes: 8, maxToolCalls: 10, deadline: Date.now() + 1200 });
    const sub = g.sub(90_000);
    // sobrou pouco: o especialista ainda ganha um tempinho, mas nunca passa do prazo da execução
    expect(sub.deadline).toBeLessThanOrEqual(g.deadline + 5);
    await new Promise((r) => setTimeout(r, 1300));
    expect(g.expired).toBe(true);
    expect(sub.expired).toBe(true);
  });

  it("sem relatório, devolve o que as ferramentas trouxeram", () => {
    const text = partialReport(
      [
        { role: "tool", tool_call_id: "1", content: JSON.stringify({ places: [{ name: "PetCamp" }] }) },
        { role: "tool", tool_call_id: "2", content: JSON.stringify({ error: "x" }) },
      ],
      true,
    );
    expect(text).toMatch(/falta de tempo/);
    expect(text).toContain("PetCamp");
    expect(text).not.toContain('"error"');
  });
});

describe("teste das lojas (Compras > Testar lojas)", () => {
  it("reconhece a proteção pelos cabeçalhos e o que a página mostrou", async () => {
    const { guardOf, pageState } = await import("../src/storecheck.js");
    expect(guardOf(new Headers({ "set-cookie": "_abck=1; bm_sz=2" }))).toBe("Akamai");
    expect(guardOf(new Headers({ "cf-ray": "x", server: "cloudflare" }))).toBe("Cloudflare");
    expect(guardOf(new Headers({ "x-datadome": "protected" }))).toBe("DataDome");
    expect(guardOf(new Headers({ server: "nginx" }))).toBeNull();
    expect(pageState("Olá! Para continuar, acesse sua conta", "https://www.mercadolivre.com.br/gz/account-verification?go=x")).toBe("desafio");
    expect(pageState("Sorry, you have been blocked! Cybersecurity Policy Violation")).toBe("bloqueado");
    expect(pageState("Ofertas do dia ".repeat(40))).toBe("ok");
  });
});
