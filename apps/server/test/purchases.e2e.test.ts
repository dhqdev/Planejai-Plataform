import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// sem DNS no sandbox: o site cadastrado como loja passa direto (a regra de rede interna tem teste próprio em net)
vi.mock("../src/net.js", async (orig) => ({ ...(await orig<typeof import("../src/net.js")>()), checkedUrl: async (u: string) => u }));

/** Compras pelo assistente (só Pix direto): Pix da loja, termos, limites, sim conferido e acompanhamento. */
describe("compras: regras sem banco", () => {
  it("lê o Pix copia e cola: CRC, valor, quem recebe; código cortado ou alterado não passa", async () => {
    const { buildPixCode, parsePixCode } = await import("../src/pixcode.js");
    const code = buildPixCode({ key: "loja@exemplo.com", cents: 8990, receiver: "LOJA EXEMPLO LTDA", city: "SAO PAULO" });
    expect(parsePixCode(code)).toMatchObject({ cents: 8990, receiver: "LOJA EXEMPLO LTDA", city: "SAO PAULO", dynamic: false });
    expect(parsePixCode(` ${code}\n`)?.payload).toBe(code);
    expect(parsePixCode(code.slice(0, -1))).toBeNull();
    expect(parsePixCode(code.replace("89.90", "19.90"))).toBeNull();
    expect(parsePixCode("oi")).toBeNull();
    const dyn = buildPixCode({ url: "pix.loja.com/qr/v2/abc", receiver: "LOJA", city: "SP" });
    expect(parsePixCode(dyn)).toMatchObject({ cents: null, dynamic: true });
  });

  it("endereço de entrega completo", async () => {
    const { cleanAddress } = await import("../src/purchases.js");
    const ok = { cep: "13010-000", street: "Rua A", number: "10", district: "Centro", city: "Campinas", state: "sp" };
    expect(cleanAddress(ok)).toMatchObject({ cep: "13010000", state: "SP" });
    expect(() => cleanAddress({ ...ok, cep: "123" })).toThrow(/CEP/);
    expect(() => cleanAddress({ ...ok, number: "" })).toThrow(/endereço/);
  });

  it("loja pela URL", async () => {
    const { storeOf } = await import("../src/purchases.js");
    expect(storeOf("https://produto.mercadolivre.com.br/MLB-123")).toBe("mercadolivre");
    expect(storeOf("https://shopee.com.br/x")).toBe("shopee");
    expect(storeOf("https://mercadolivre.com.br.golpe.com/")).toBeNull();
    expect(storeOf("lixo")).toBeNull();
    expect(storeOf("https://www.kabum.com.br/produto/1")).toBe("kabum");
  });

  it("cookies colados: JSON da extensão, cookies.txt e cabeçalho", async () => {
    const { parseCookieText } = await import("../src/storelogin.js");
    const json = JSON.stringify([{ name: "ssid", value: "abc", domain: ".mercadolivre.com.br", path: "/", expirationDate: 1900000000.5, httpOnly: true, secure: true, sameSite: "no_restriction" }]);
    expect(parseCookieText(json, "mercadolivre.com.br")).toEqual([
      { name: "ssid", value: "abc", domain: ".mercadolivre.com.br", path: "/", expires: 1900000000.5, httpOnly: true, secure: true, sameSite: "None" },
    ]);
    const txt = "# Netscape HTTP Cookie File\n#HttpOnly_.shopee.com.br\tTRUE\t/\tTRUE\t1900000000\tSPC_EC\txyz\n";
    expect(parseCookieText(txt, "shopee.com.br")).toMatchObject([{ name: "SPC_EC", value: "xyz", domain: ".shopee.com.br", httpOnly: true, secure: true }]);
    expect(parseCookieText("Cookie: a=1; b=2=3", "kabum.com.br")).toMatchObject([
      { name: "a", value: "1", domain: ".kabum.com.br" },
      { name: "b", value: "2=3" },
    ]);
    expect(() => parseCookieText("[{", "x.com")).toThrow(/JSON/);
  });

  it("código de verificação no e-mail da loja", async () => {
    const { extractLoginCode } = await import("../src/stores.js");
    expect(extractLoginCode("Seu código de verificação é 482913. Válido por 10 minutos")).toBe("482913");
    expect(extractLoginCode("Use the code 7731 to sign in")).toBe("7731");
    expect(extractLoginCode("Acesse sua conta: 384756")).toBe("384756");
    expect(extractLoginCode("Pedido 2026 confirmado, total R$ 152,90")).toBeNull();
  });
});

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("compras pelo assistente (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let shop: typeof import("../src/purchases.js");
  let settings: typeof import("../src/settings.js");
  let pix: typeof import("../src/pixcode.js");
  let user: any;
  let convId: string;
  let app: any;
  const realFetch = globalThis.fetch;
  let decodeCents = 0;
  let n = 0;
  // valor de cada cobrança dinâmica no "banco da loja" (o JWS que o endereço do campo 25 devolve)
  const charges = new Map<string, number>();
  const jws = (cents: number) => `e30.${Buffer.from(JSON.stringify({ valor: { original: (cents / 100).toFixed(2) } })).toString("base64url")}.sig`;
  const outbox = async () => (await db.many("SELECT data FROM pgboss.job WHERE name = 'outbound.send' ORDER BY created_on")).map((r) => r.data);
  const code = (cents: number, written = cents) => {
    const url = `pix.loja.com/qr/v2/${++n}`;
    charges.set(url, cents);
    return pix.buildPixCode({ url, cents: written, receiver: "MERCADO PAGO", city: "OSASCO" });
  };
  const dynamic = () => pix.buildPixCode({ url: `pix.semresposta.com/qr/${++n}`, receiver: "LOJA", city: "SP" });
  const row = (id: string) => db.one("SELECT * FROM purchases WHERE id = $1", [id]);

  beforeAll(async () => {
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      const charge = charges.get(u.replace(/^https:\/\//, ""));
      if (charge != null) return new Response(jws(charge), { status: 200 });
      if (u.includes("pix.semresposta.com")) return new Response("", { status: 404 });
      if (!u.includes("asaas.com")) return realFetch(url, init);
      const body = init?.body ? JSON.parse(init.body) : null;
      return new Response(JSON.stringify({ payload: body?.payload, value: decodeCents / 100, receiver: { name: "Loja Dinâmica" } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    shop = await import("../src/purchases.js");
    settings = await import("../src/settings.js");
    pix = await import("../src/pixcode.js");
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    user = await upsertUser("5519955550000", "Carla");
    await db.query("UPDATE users SET status = 'active' WHERE id = $1", [user.id]);
    convId = (await upsertConversation(user.id, "playground", "jid-carla-compras")).id;
    app = await (await import("../src/api/server.js")).buildServer();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await app?.close();
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  it("desligado ou sem termos aceitos, nada sai", async () => {
    await expect(shop.preparePurchase(user.id, { title: "Fone", url: "https://www.mercadolivre.com.br/x", pix_code: code(8990) })).rejects.toThrow(/não estão ligadas/);
    await settings.saveSettings({ purchasesEnabled: true });
    await expect(shop.preparePurchase(user.id, { title: "Fone", url: "https://www.mercadolivre.com.br/x", pix_code: code(8990) })).rejects.toThrow(/Termos de compra/);
    await shop.acceptPurchaseTerms(user.id, "200.1.2.3");
  });

  it("pergunta o sim com o valor do Pix e, no sim, manda o código sozinho para a pessoa pagar", async () => {
    await db.query("DELETE FROM pgboss.job WHERE name = 'outbound.send'");
    const { purchaseStart } = await import("../src/agent/tools/purchases.js");
    const args = { title: "Fone JBL", pix_code: code(8990) };
    // o navegador está no checkout da loja e o Pix está na página
    const browser: any = { page: { url: () => "https://www.mercadolivre.com.br/checkout/pix" }, snapshot: async () => ({ pix: [args.pix_code] }) };
    const ctx: any = { user, conversation: { id: convId }, agent: "compras", room: { browser }, toolCall: { name: "purchase_start", args } };
    const asked: any = await purchaseStart.run(args, ctx);
    expect(asked.needs_confirmation).toBe(true);
    expect(asked.message).toContain('comprar "Fone JBL" no Mercado Livre por R$ 89,90 (Pix para MERCADO PAGO)');
    const pending = await db.one("SELECT * FROM pending_actions WHERE conversation_id = $1 AND tool = 'purchase_start' AND status = 'pending'", [convId]);
    // a pessoa disse "sim": o sistema roda de novo exatamente o que ficou guardado
    const done: any = await purchaseStart.run(pending.args, { ...ctx, approvedAction: true });
    expect(done.ok).toBe(true);
    const p = await db.one("SELECT * FROM purchases WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [user.id]);
    expect(p).toMatchObject({ store: "mercadolivre", store_cents: 8990, total_cents: 8990, method: "pix", status: "awaiting_person" });
    expect((await outbox()).map((o) => o.text)).toContain(args.pix_code);
    // um segundo "sim" não faz nada
    expect(((await purchaseStart.run(pending.args, { ...ctx, approvedAction: true })) as any).ok).toBe(false);
    // ela avisou que pagou, depois que chegou
    expect((await shop.updatePurchase(user.id, p.id, { status: "paid", order_ref: "2000123" }))!.status).toBe("paid");
    expect(await shop.updatePurchase(user.id, p.id, { status: "delivered", tracking: "BR1" })).toMatchObject({ status: "delivered", order_ref: "2000123", tracking: "BR1" });
  });

  it("Pix fixo, valor escrito diferente da cobrança, Pix fora da página e loja desconhecida não passam", async () => {
    const fixo = pix.buildPixCode({ key: "golpista@x.com", cents: 8990, receiver: "LOJA OFICIAL", city: "SP" });
    await expect(shop.preparePurchase(user.id, { title: "Fone", url: "https://www.mercadolivre.com.br/x", pix_code: fixo })).rejects.toThrow(/fixo/);
    await expect(shop.preparePurchase(user.id, { title: "Fone", url: "https://www.mercadolivre.com.br/x", pix_code: code(15000, 8990) })).rejects.toThrow(/não bate/);
    await expect(shop.preparePurchase(user.id, { title: "Fone", url: "https://golpe.com/x", pix_code: code(8990) })).rejects.toThrow(/não é de uma loja/);
    const { purchaseStart } = await import("../src/agent/tools/purchases.js");
    const planted = code(8990);
    const ctx = (url: string, onPage: string[]): any => ({ user, conversation: { id: convId }, agent: "compras", room: { browser: { page: { url: () => url }, snapshot: async () => ({ pix: onPage }) } } });
    // código que o modelo trouxe de outro lugar (anúncio, mensagem) e não está na página aberta
    expect(await purchaseStart.run({ title: "Fone", pix_code: planted }, ctx("https://www.mercadolivre.com.br/checkout", [code(8990)]))).toMatchObject({ ok: false, error: expect.stringMatching(/não está na página/) });
    // página de outro site
    expect(await purchaseStart.run({ title: "Fone", pix_code: planted }, ctx("https://golpe.com/pix", [planted]))).toMatchObject({ ok: false, error: expect.stringMatching(/não é de uma loja/) });
    // sem navegador aberto
    expect(await purchaseStart.run({ title: "Fone", pix_code: planted }, { user, room: {} } as any)).toMatchObject({ ok: false });
  });

  it("Pix dinâmico sem resposta do banco da loja: sem Asaas não confere; com Asaas lê a cobrança (só leitura)", async () => {
    await expect(shop.preparePurchase(user.id, { title: "Mouse", url: "https://shopee.com.br/m", pix_code: dynamic() })).rejects.toThrow(/conferir o valor/);
    const { saveCredentials } = await import("../src/integrations/registry.js");
    await saveCredentials("asaas", { api_key: "$aact_hmlg_teste", webhook_token: "x".repeat(20) });
    decodeCents = 4590;
    const { purchase } = await shop.preparePurchase(user.id, { title: "Mouse", url: "https://shopee.com.br/m", pix_code: dynamic() });
    expect(purchase).toMatchObject({ store: "shopee", store_cents: 4590, store_receiver: "Loja Dinâmica" });
  });

  it("limites do dono: por compra e em 30 dias; o dono mudou entre a pergunta e o sim, vale a regra nova", async () => {
    await settings.saveSettings({ purchaseMaxCents: 5000 });
    await expect(shop.preparePurchase(user.id, { title: "X", url: "https://www.amazon.com.br/x", pix_code: code(6000) })).rejects.toThrow(/limite por compra/);
    await settings.saveSettings({ purchaseMaxCents: 30_000, purchaseMonthMaxCents: 12_000 });
    // já tem 89,90 entregue nos últimos 30 dias
    await expect(shop.preparePurchase(user.id, { title: "X", url: "https://www.amazon.com.br/x", pix_code: code(4000) })).rejects.toThrow(/30 dias/);
    await settings.saveSettings({ purchaseMonthMaxCents: 100_000 });
    const { purchase } = await shop.preparePurchase(user.id, { title: "Livro", url: "https://www.amazon.com.br/l", pix_code: code(4000) });
    await settings.saveSettings({ purchasesEnabled: false });
    expect((await shop.approvePurchase(user.id, purchase.id)).ok).toBe(false);
    expect((await row(purchase.id)).status).toBe("canceled");
    await settings.saveSettings({ purchasesEnabled: true });
  });

  it("rodada: pedido sem sim em 30 min e Pix não pago em 2 dias caem", async () => {
    const a = (await shop.preparePurchase(user.id, { title: "A", url: "https://www.amazon.com.br/a", pix_code: code(1000) })).purchase;
    await db.query("UPDATE purchases SET created_at = now() - interval '31 minutes' WHERE id = $1", [a.id]);
    const b = (await shop.preparePurchase(user.id, { title: "B", url: "https://www.amazon.com.br/b", pix_code: code(1000) })).purchase;
    await shop.approvePurchase(user.id, b.id);
    await db.query("UPDATE purchases SET updated_at = now() - interval '3 days' WHERE id = $1", [b.id]);
    expect(await shop.checkOpenPurchases()).toEqual({ canceled: 1 });
    expect((await row(a.id)).status).toBe("canceled");
    expect((await row(b.id)).status).toBe("canceled");
  });

  it("painel: endereço criptografado, dono vê só números e a regra pública", async () => {
    const res = await shop.saveBuyerAddress(user.id, { cep: "13010000", street: "Rua B", number: "20", district: "Centro", city: "Campinas", state: "SP" });
    expect(res).toMatchObject({ address: { street: "Rua B" }, terms: { accepted: true } });
    expect((await db.one("SELECT data FROM buyer_profiles WHERE user_id = $1", [user.id])).data).not.toContain("Rua B");
    expect(await shop.purchasesOverview()).toMatchObject({ paid: 1, stores_cents: 8990 });
    const cfg = (await app.inject({ method: "GET", url: "/api/auth/config" })).json();
    expect(cfg.purchases).toMatchObject({ enabled: true, maxCents: 30_000 });
  });

  it("lojas: cadastrada pela pessoa, acesso salvo criptografado e senha digitada só no site da loja", async () => {
    const st = await import("../src/stores.js");
    await expect(st.addCustomStore(user.id, { url: "com.br" })).rejects.toThrow(/inválido/);
    await expect(st.addCustomStore(user.id, { url: "https://mail.google.com" })).rejects.toThrow(/não é uma loja/);
    await expect(st.addCustomStore(user.id, { url: "http://lojinha.com.br" })).rejects.toThrow(/https/);
    expect(await st.addCustomStore(user.id, { url: "https://produto.mercadolivre.com.br/x" })).toMatchObject({ id: "mercadolivre" });
    const custom = await st.addCustomStore(user.id, { name: "Loja do Bairro", url: "www.lojadobairro.com.br/promo" });
    expect(custom).toMatchObject({ id: "u-lojadobairro-com-br", domains: ["lojadobairro.com.br"] });
    expect(await st.storeOfFor(user.id, "https://loja.lojadobairro.com.br/p/1")).toBe(custom.id);
    expect(await st.storeOfFor(user.id, "https://lojadobairro.com.br.golpe.com/")).toBeNull();

    await st.saveStoreAccess(user.id, custom.id, { email: "carla@x.com", password: "s3gredo!" });
    expect((await db.one("SELECT data FROM store_logins WHERE user_id = $1 AND store = $2", [user.id, custom.id])).data).not.toContain("s3gredo");
    // senha em branco ao editar mantém a anterior
    await st.saveStoreAccess(user.id, custom.id, { email: "carla2@x.com" });
    expect(await st.storeAccess(user.id, custom.id)).toEqual({ email: "carla2@x.com", password: "s3gredo!" });
    const { connectedStores } = await import("../src/storelogin.js");
    expect((await connectedStores(user.id)).find((x) => x.id === custom.id)).toMatchObject({ custom: true, access: true, connected: false });

    const { storeLoginFill } = await import("../src/agent/tools/purchases.js");
    const typed: string[] = [];
    const fake: any = {
      page: { url: () => "https://golpe.com/login" },
      fillSecret: async (_ref: number, v: string) => void typed.push(v),
      snapshot: async () => ({ url: "x", title: "", text: "", elements: "" }),
      store: null,
      saveLogin: false,
    };
    const ctx: any = { user, room: { browser: fake }, agent: "compras" };
    expect(await storeLoginFill.run({ ref: 1, field: "password" }, ctx)).toMatchObject({ ok: false });
    expect(typed).toEqual([]);
    fake.page.url = () => "https://www.lojadobairro.com.br/entrar";
    const r: any = await storeLoginFill.run({ ref: 1, field: "password" }, ctx);
    expect(r.ok).toBe(true);
    expect(typed).toEqual(["s3gredo!"]);
    expect(JSON.stringify(r)).not.toContain("s3gredo");
    expect(fake).toMatchObject({ store: custom.id, saveLogin: true });

    // cookies colados: só os da própria loja ficam, criptografados
    const sl = await import("../src/storelogin.js");
    const pasted = JSON.stringify([
      { name: "sess", value: "ok", domain: ".lojadobairro.com.br" },
      { name: "track", value: "x", domain: ".google.com" },
    ]);
    expect(await sl.importStoreCookies(user.id, custom.id, pasted)).toMatchObject({ ok: true, count: 1 });
    expect((await sl.storeCookies(user.id, custom.id)).map((c) => c.name)).toEqual(["sess"]);
    expect((await db.one("SELECT cookies FROM store_sessions WHERE user_id = $1 AND store = $2", [user.id, custom.id])).cookies).not.toContain("sess");
    await expect(sl.importStoreCookies(user.id, custom.id, JSON.stringify([{ name: "a", value: "b", domain: "google.com" }]))).rejects.toThrow(/Nenhum/);
    await expect(sl.importStoreCookies(user.id, "nao-existe", pasted)).rejects.toThrow(/não encontrada/);

    await st.removeCustomStore(user.id, custom.id);
    expect(await st.storeAccess(user.id, custom.id)).toBeNull();
    expect(await st.storeOfFor(user.id, "https://lojadobairro.com.br/")).toBeNull();
  });
});
