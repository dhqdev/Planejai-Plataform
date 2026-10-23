import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Checkout próprio (/pagar/<token>): link assinado, Pix, boleto e cartão pela API do Asaas, crédito uma vez só. */
describe("checkout: regras sem banco", () => {
  it("o token do link só abre a cobrança certa", async () => {
    const { payToken, paymentIdOf, payLink } = await import("../src/paylink.js");
    const t = payToken("pay_123");
    expect(paymentIdOf(t)).toBe("pay_123");
    expect(payLink("pay_123")).toMatch(/\/pagar\/pay_123\.[A-Za-z0-9_-]{22}$/);
    // trocar o id ou a assinatura não abre nada
    expect(paymentIdOf(t.replace("pay_123", "pay_124"))).toBeNull();
    expect(paymentIdOf(`${t.slice(0, -1)}x`)).toBeNull();
    expect(paymentIdOf("pay_123")).toBeNull();
    expect(paymentIdOf("../x.abc")).toBeNull();
  });

  it("cartão: número, validade, CVV, CPF, CEP e e-mail conferidos antes de ir ao Asaas", async () => {
    const { cardCharge, luhn } = await import("../src/checkout.js");
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("4111111111111112")).toBe(false);
    const ok = { number: "4111 1111 1111 1111", holderName: " Carla  Dias ", expiry: "12/40", ccv: "123", cpfCnpj: "529.982.247-25", postalCode: "01310-100", addressNumber: "10" };
    const c = cardCharge(ok, { email: "carla@exemplo.com", phone: "5519944440000" }, "1.2.3.4");
    expect(c).toEqual({
      creditCard: { holderName: "Carla Dias", number: "4111111111111111", expiryMonth: "12", expiryYear: "2040", ccv: "123" },
      creditCardHolderInfo: { name: "Carla Dias", email: "carla@exemplo.com", cpfCnpj: "52998224725", postalCode: "01310100", addressNumber: "10", mobilePhone: "19944440000" },
      remoteIp: "1.2.3.4",
    });
    const who = { email: "carla@exemplo.com" };
    expect(() => cardCharge({ ...ok, number: "4111111111111112" }, who, "")).toThrow(/número do cartão/);
    expect(() => cardCharge({ ...ok, expiry: "13/40" }, who, "")).toThrow(/validade/);
    expect(() => cardCharge({ ...ok, expiry: "01/20" }, who, "")).toThrow(/validade/);
    expect(() => cardCharge({ ...ok, ccv: "12" }, who, "")).toThrow(/CVV/);
    expect(() => cardCharge({ ...ok, cpfCnpj: "111.111.111-11" }, who, "")).toThrow(/CPF/);
    expect(() => cardCharge({ ...ok, postalCode: "123" }, who, "")).toThrow(/CEP/);
    expect(() => cardCharge(ok, { email: null }, "")).toThrow(/e-mail/);
  });
});

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("checkout próprio (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let billing: typeof import("../src/billing.js");
  let paylink: typeof import("../src/paylink.js");
  let settings: typeof import("../src/settings.js");
  let user: any;
  let app: any;
  const realFetch = globalThis.fetch;
  const calls: { method: string; path: string; body: any }[] = [];
  const pays = new Map<string, any>();
  let n = 0;
  const TOKEN = "token-do-webhook-bem-comprido";
  const wallet = async () => db.one("SELECT plan_grains, extra_grains FROM wallets WHERE user_id = $1", [user.id]);
  const card = { number: "4111 1111 1111 1111", holderName: "Carla Dias", expiry: "12/40", ccv: "123", cpfCnpj: "529.982.247-25", postalCode: "01310-100", addressNumber: "10" };
  const tokenOf = (id: string) => paylink.payToken(id);

  beforeAll(async () => {
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (!u.includes("asaas.com")) return realFetch(url, init);
      const path = u.replace(/^https:\/\/[^/]+\/v3/, "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ method, path, body });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      const today = new Date().toISOString().slice(0, 10);
      if (path === "/customers") return json({ id: "cus_1" });
      if (path === "/payments" && method === "POST") {
        const p = { id: `pay_${++n}`, status: "PENDING", customer: body.customer, value: body.value, dueDate: body.dueDate, billingType: body.billingType, externalReference: body.externalReference, description: body.description, invoiceUrl: `https://sandbox.asaas.com/i/${n}` };
        pays.set(p.id, p);
        return json(p);
      }
      if (path === "/subscriptions" && method === "POST") {
        const id = `sub_${++n}`;
        const p = { id: `pay_${id}`, subscription: id, status: body.creditCard ? "CONFIRMED" : "PENDING", value: body.value, dueDate: today, billingType: body.billingType, creditCard: body.creditCard ? { creditCardNumber: "1111", creditCardBrand: "VISA", creditCardToken: "tok_sub" } : undefined };
        pays.set(p.id, p);
        return json({ id });
      }
      const subPays = path.match(/^\/subscriptions\/([^/]+)\/payments$/);
      if (subPays) return json({ data: [...pays.values()].filter((p) => p.subscription === subPays[1]) });
      const m = path.match(/^\/payments\/([^/]+)(\/[A-Za-z]+)?$/);
      if (m) {
        const p = pays.get(m[1]!);
        if (!p) return json({ errors: [{ description: "Cobrança não encontrada" }] }, 404);
        if (!m[2] && method === "GET") return json(p);
        if (!m[2] && method === "POST") return json(Object.assign(p, body, { bankSlipUrl: body.billingType === "BOLETO" ? `https://sandbox.asaas.com/b/pdf/${p.id}` : p.bankSlipUrl }));
        if (m[2] === "/pixQrCode") return json({ encodedImage: "iVBORw0KGgo=", payload: "00020126pix-copia-e-cola", expirationDate: "2099-01-01 23:59:59" });
        if (m[2] === "/identificationField") return json({ identificationField: "23793.38128 60000.000003 00000.000400 1 99990000001000" });
        if (m[2] === "/payWithCreditCard") {
          if (body.creditCard.holderName === "Recusa Sempre") return json({ errors: [{ description: "Transação não autorizada." }] }, 400);
          Object.assign(p, { status: "CONFIRMED", billingType: "CREDIT_CARD", creditCard: { creditCardNumber: "1111", creditCardBrand: "VISA", creditCardToken: "tok_pack" } });
          return json(p);
        }
      }
      return json({ ok: true });
    }) as typeof fetch;
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    billing = await import("../src/billing.js");
    paylink = await import("../src/paylink.js");
    settings = await import("../src/settings.js");
    const { saveCredentials } = await import("../src/integrations/registry.js");
    await saveCredentials("asaas", { api_key: "$aact_hmlg_teste", webhook_token: TOKEN });
    const { upsertUser } = await import("../src/ingest.js");
    user = await upsertUser("5519944440000", "Carla");
    await db.query("UPDATE users SET status = 'active', full_name = 'Carla Dias', email = 'carla@exemplo.com', created_at = now() - interval '30 days' WHERE id = $1", [user.id]);
    user = await db.one("SELECT * FROM users WHERE id = $1", [user.id]);
    await settings.saveSettings({ billingEnabled: true });
    app = await (await import("../src/api/server.js")).buildServer();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await app?.close();
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  it("pacote por Pix: o link é o nosso, mostra o QR e, quando cai, credita uma vez só (webhook depois não repete)", async () => {
    const pack = settings.DEFAULT_PACKS[0]!;
    const before = Number((await wallet())?.extra_grains ?? 300);
    const p = await billing.buyPack(user, pack.id, { name: "Carla Dias", cpfCnpj: "529.982.247-25" });
    expect(p.invoice_url).toBe(paylink.payLink(p.asaas_payment_id));
    const token = tokenOf(p.asaas_payment_id);
    const view = (await app.inject({ method: "GET", url: `/api/pay/${token}` })).json();
    expect(view).toMatchObject({ kind: "pack", value: pack.price, grains: pack.grains, paid: false, open: true, firstName: "Carla", needsEmail: false });
    const pix = (await app.inject({ method: "POST", url: `/api/pay/${token}/pix` })).json();
    expect(pix).toMatchObject({ paid: false, image: "data:image/png;base64,iVBORw0KGgo=", code: "00020126pix-copia-e-cola" });
    expect((await app.inject({ method: "GET", url: `/api/pay/${token}/status` })).json()).toMatchObject({ paid: false, open: true });
    // o Pix caiu no Asaas: a conferência da tela credita sem esperar o webhook
    pays.get(p.asaas_payment_id).status = "RECEIVED";
    expect((await app.inject({ method: "GET", url: `/api/pay/${token}/status` })).json()).toMatchObject({ paid: true });
    expect((await app.inject({ method: "GET", url: `/api/pay/${token}/status` })).json()).toMatchObject({ paid: true });
    const hook = await app.inject({ method: "POST", url: "/webhooks/asaas", headers: { "asaas-access-token": TOKEN }, payload: { id: "evt_pix", event: "PAYMENT_RECEIVED", payment: pays.get(p.asaas_payment_id) } });
    expect(hook.statusCode).toBe(200);
    expect(Number((await wallet()).extra_grains)).toBe(before + pack.grains);
    expect(await db.one("SELECT count(*)::int AS n FROM grain_ledger WHERE user_id = $1 AND reason = 'pacote'", [user.id])).toEqual({ n: 1 });
  });

  it("token trocado ou cobrança que não é nossa não abre", async () => {
    expect((await app.inject({ method: "GET", url: "/api/pay/pay_1.assinaturaerrada12345678" })).statusCode).toBe(404);
    pays.set("pay_alheio", { id: "pay_alheio", status: "PENDING", value: 10, externalReference: "outra-coisa" });
    expect((await app.inject({ method: "GET", url: `/api/pay/${tokenOf("pay_alheio")}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/pay/${tokenOf("pay_alheio")}/card`, payload: card })).statusCode).toBe(404);
  });

  it("boleto: vira boleto no Asaas e mostra a linha e o PDF", async () => {
    const pack = settings.DEFAULT_PACKS[1]!;
    const p = await billing.buyPack(user, pack.id);
    const r = (await app.inject({ method: "POST", url: `/api/pay/${tokenOf(p.asaas_payment_id)}/boleto` })).json();
    expect(r).toMatchObject({ paid: false, line: expect.stringContaining("23793.38128"), pdf: `https://sandbox.asaas.com/b/pdf/${p.asaas_payment_id}` });
    expect(calls.find((c) => c.method === "POST" && c.path === `/payments/${p.asaas_payment_id}`)?.body).toMatchObject({ billingType: "BOLETO" });
  });

  it("cartão no pacote: erro de digitação para antes; recusa explica; aprovado credita na hora e guarda o cartão", async () => {
    const pack = settings.DEFAULT_PACKS[2] ?? settings.DEFAULT_PACKS[0]!;
    const before = Number((await wallet()).extra_grains);
    const p = await billing.buyPack(user, pack.id);
    const url = `/api/pay/${tokenOf(p.asaas_payment_id)}/card`;
    const typo = await app.inject({ method: "POST", url, payload: { ...card, number: "4111 1111 1111 1112" } });
    expect(typo.statusCode).toBe(400);
    expect(typo.json().error).toMatch(/número do cartão/);
    const refused = await app.inject({ method: "POST", url, payload: { ...card, holderName: "Recusa Sempre" } });
    expect(refused.json().error).toMatch(/não passou/);
    calls.length = 0;
    const ok = (await app.inject({ method: "POST", url, payload: card })).json();
    expect(ok).toMatchObject({ paid: true });
    const pay = calls.find((c) => c.path.endsWith("/payWithCreditCard"));
    expect(pay?.body).toMatchObject({ creditCard: { number: "4111111111111111", expiryYear: "2040" }, creditCardHolderInfo: { email: "carla@exemplo.com", postalCode: "01310100", cpfCnpj: "52998224725" } });
    expect(Number((await wallet()).extra_grains)).toBe(before + pack.grains);
    const sub = await db.one("SELECT saved_card_last4, saved_card_token IS NOT NULL AS has FROM subscriptions WHERE user_id = $1", [user.id]);
    expect(sub).toEqual({ saved_card_last4: "1111", has: true });
    // pagou: o link mostra pronto e não cobra de novo
    expect((await app.inject({ method: "GET", url: `/api/pay/${tokenOf(p.asaas_payment_id)}` })).json()).toMatchObject({ paid: true });
    expect((await app.inject({ method: "POST", url, payload: card })).json()).toMatchObject({ paid: true });
    expect(calls.filter((c) => c.path.endsWith("/payWithCreditCard"))).toHaveLength(1);
  });

  it("plano no cartão: assina com o cartão no Asaas (renova sozinho) e credita na hora, uma vez só", async () => {
    const { cardCharge } = await import("../src/checkout.js");
    const plan = settings.DEFAULT_PLANS[0]!;
    calls.length = 0;
    const sub = await billing.subscribe(user, { planId: plan.id, card: cardCharge(card, { email: user.email, phone: user.phone }, "1.2.3.4") });
    expect(sub).toMatchObject({ paid: true, status: "trial", pay_method: "card", invoice_url: null });
    expect(calls.find((c) => c.path === "/subscriptions")?.body).toMatchObject({ billingType: "CREDIT_CARD", creditCard: { number: "4111111111111111" }, remoteIp: "1.2.3.4" });
    expect(Number((await wallet()).plan_grains)).toBe(plan.grains);
    const row = await db.one("SELECT status, card_last4 FROM subscriptions WHERE user_id = $1", [user.id]);
    expect(row).toEqual({ status: "active", card_last4: "1111" });
    // o webhook do mesmo pagamento chega depois: não credita de novo
    await app.inject({ method: "POST", url: "/webhooks/asaas", headers: { "asaas-access-token": TOKEN }, payload: { id: "evt_sub", event: "PAYMENT_CONFIRMED", payment: pays.get(`pay_${sub.asaas_subscription_id}`) } });
    expect(await db.one("SELECT count(*)::int AS n FROM grain_ledger WHERE user_id = $1 AND reason = 'plano'", [user.id])).toEqual({ n: 1 });
  });
});
