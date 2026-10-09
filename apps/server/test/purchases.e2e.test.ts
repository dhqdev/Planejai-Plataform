import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Compras pelo assistente: Pix da loja, Pix direto, cartão (token e primeira vez), saldo, limites, estorno e validação de saque. */
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

  it("taxa: Pix direto sem taxa; cartão e saldo com a % do dono e um mínimo, em centavos", async () => {
    const { feeFor } = await import("../src/purchases.js");
    const s = { purchaseFeePercent: 5, purchaseFeeMinCents: 290 } as any;
    expect(feeFor(10_000, "pix", s)).toBe(0);
    expect(feeFor(10_000, "card", s)).toBe(500);
    expect(feeFor(1_000, "wallet", s)).toBe(290);
    expect(feeFor(8_990, "card", s)).toBe(450);
  });

  it("dados de compra: CPF, maior de idade e endereço completo", async () => {
    const { cleanBuyerData } = await import("../src/purchases.js");
    const ok = { full_name: "Carla  Dias", cpf: "529.982.247-25", birth_date: "1990-05-10", address: { cep: "13010-000", street: "Rua A", number: "10", district: "Centro", city: "Campinas", state: "sp" } };
    expect(cleanBuyerData(ok)).toMatchObject({ full_name: "Carla Dias", cpf: "52998224725", address: { cep: "13010000", state: "SP" } });
    expect(() => cleanBuyerData({ ...ok, cpf: "529.982.247-26" })).toThrow(/CPF/);
    expect(() => cleanBuyerData({ ...ok, birth_date: new Date().toISOString().slice(0, 10) })).toThrow(/18 anos/);
    expect(() => cleanBuyerData({ ...ok, address: { ...ok.address, number: "" } })).toThrow(/endereço/);
    expect(() => cleanBuyerData({ ...ok, full_name: "Carla" })).toThrow(/nome completo/);
  });

  it("loja pela URL", async () => {
    const { storeOf } = await import("../src/purchases.js");
    expect(storeOf("https://produto.mercadolivre.com.br/MLB-123")).toBe("mercadolivre");
    expect(storeOf("https://shopee.com.br/x")).toBe("shopee");
    expect(storeOf("https://mercadolivre.com.br.golpe.com/")).toBeNull();
    expect(storeOf("lixo")).toBeNull();
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
  const calls: { method: string; path: string; body: any }[] = [];
  const TOKEN = "token-do-webhook-de-compras";
  // o que o "Asaas" responde em cada teste
  let decodeCents = 0;
  let cardStatus = "CONFIRMED";
  let pixStatus = "DONE";
  let payFails = false;
  let n = 0;
  const outbox = async () => (await db.many("SELECT data FROM pgboss.job WHERE name = 'outbound.send' ORDER BY created_on")).map((r) => r.data);
  const hook = (body: unknown, url = "/webhooks/asaas") => app.inject({ method: "POST", url, headers: { "asaas-access-token": TOKEN }, payload: body as any });
  const code = (cents: number, txid = `t${++n}`) => pix.buildPixCode({ key: "loja@exemplo.com", cents, receiver: "MERCADO PAGO", city: "OSASCO", txid });
  const row = (id: string) => db.one("SELECT * FROM purchases WHERE id = $1", [id]);
  const fresh = async () => {
    calls.length = 0;
    await db.query("DELETE FROM pgboss.job WHERE name = 'outbound.send'");
    await db.query("UPDATE purchases SET status = 'canceled' WHERE status NOT IN ('paid', 'delivered', 'failed', 'refunded', 'canceled')");
  };

  beforeAll(async () => {
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (!u.includes("asaas.com")) return realFetch(url, init);
      const path = u.replace(/^https:\/\/[^/]+\/v3/, "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ method, path, body });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (path === "/customers") return json({ id: "cus_1" });
      if (path === "/pix/qrCodes/decode") return json({ payload: body.payload, value: decodeCents / 100, totalValue: decodeCents / 100, receiver: { name: "Mercado Pago" }, canBePaid: true });
      if (path === "/pix/qrCodes/pay") return payFails ? json({ errors: [{ description: "Saldo insuficiente" }] }, 400) : json({ id: `tx_${++n}`, status: pixStatus, value: body.value });
      if (path.startsWith("/pix/transactions/")) return json({ id: path.split("/").pop(), status: pixStatus });
      if (path === "/payments" && method === "POST") {
        const id = `pay_${++n}`;
        return json({ id, invoiceUrl: `https://sandbox.asaas.com/i/${id}`, status: body.creditCardToken ? cardStatus : "PENDING" });
      }
      return json({ ok: true });
    }) as typeof fetch;
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    shop = await import("../src/purchases.js");
    settings = await import("../src/settings.js");
    pix = await import("../src/pixcode.js");
    const { saveCredentials } = await import("../src/integrations/registry.js");
    await saveCredentials("asaas", { api_key: "$aact_hmlg_teste", webhook_token: TOKEN });
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    user = await upsertUser("5519955550000", "Carla");
    await db.query("UPDATE users SET status = 'active', full_name = 'Carla Dias' WHERE id = $1", [user.id]);
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

  it("desligado ou sem termos aceitos, nada sai; com tudo certo, o Pix direto vai para a pessoa sem taxa", async () => {
    decodeCents = 8990;
    await expect(shop.preparePurchase(user.id, { title: "Fone", url: "https://www.mercadolivre.com.br/x", pix_code: code(8990), method: "pix" })).rejects.toThrow(/não estão ligadas/);
    await settings.saveSettings({ purchasesEnabled: true });
    await expect(shop.preparePurchase(user.id, { title: "Fone", url: "https://www.mercadolivre.com.br/x", pix_code: code(8990), method: "pix" })).rejects.toThrow(/Termos de compra/);
    await shop.acceptPurchaseTerms(user.id, "200.1.2.3");
    await fresh();
    const pixCode = code(8990);
    const { purchase, summary } = await shop.preparePurchase(user.id, { title: "Fone JBL", url: "https://www.mercadolivre.com.br/x", pix_code: pixCode, method: "pix" });
    expect(purchase).toMatchObject({ store: "mercadolivre", store_cents: 8990, fee_cents: 0, total_cents: 8990, status: "awaiting_confirm" });
    expect(summary).toContain("R$ 89,90");
    // cartão desligado pelo dono: não deixa nem preparar
    await expect(shop.preparePurchase(user.id, { title: "Fone", url: "https://www.mercadolivre.com.br/x", pix_code: code(8990), method: "card" })).rejects.toThrow(/não está ligado/);
    const r = await shop.approvePurchase(user.id, purchase.id);
    expect(r.ok).toBe(true);
    expect((await row(purchase.id)).status).toBe("awaiting_person");
    expect((await outbox()).map((o) => o.text)).toContain(pixCode);
    // um segundo "sim" não faz nada
    expect((await shop.approvePurchase(user.id, purchase.id)).ok).toBe(false);
    // a pessoa avisou que pagou
    expect((await shop.updatePurchase(user.id, purchase.id, { status: "paid", order_ref: "2000123" }))!.status).toBe("paid");
    expect(calls.some((c) => c.path === "/pix/qrCodes/pay")).toBe(false);
  });

  it("valor do Pix escrito no código diferente do que o Asaas lê: recusa", async () => {
    await fresh();
    decodeCents = 1000;
    await expect(shop.preparePurchase(user.id, { title: "Fone", url: "https://www.mercadolivre.com.br/x", pix_code: code(8990), method: "pix" })).rejects.toThrow(/não bate/);
  });

  it("cartão com token: pergunta o sim pela ferramenta, cobra o total com taxa e paga a loja com o valor exato", async () => {
    await settings.saveSettings({ purchaseCard: true, purchaseCardNeedsPlan: false });
    await shop.saveBuyerProfile(user.id, { full_name: "Carla Dias", cpf: "52998224725", birth_date: "1990-05-10", address: { cep: "13010000", street: "Rua A", number: "10", district: "Centro", city: "Campinas", state: "SP" } }, "200.1.2.3");
    const { encryptJson } = await import("../src/crypto.js");
    await db.query("UPDATE buyer_profiles SET card_token = $2, card_brand = 'VISA', card_last4 = '4242' WHERE user_id = $1", [user.id, encryptJson({ token: "tok_123" })]);
    await fresh();
    decodeCents = 10_000;
    cardStatus = "CONFIRMED";
    pixStatus = "DONE";
    const { purchaseStart } = await import("../src/agent/tools/purchases.js");
    const args = { title: "Air fryer", url: "https://www.mercadolivre.com.br/af", pix_code: code(10_000), method: "card" as const };
    const ctx: any = { user, conversation: { id: convId }, agent: "compras", toolCall: { name: "purchase_start", args } };
    const asked: any = await purchaseStart.run(args, ctx);
    expect(asked.needs_confirmation).toBe(true);
    expect(asked.message).toContain("R$ 100,00 + R$ 5,00 de taxa = R$ 105,00 no cartão final 4242");
    const pending = await db.one("SELECT * FROM pending_actions WHERE conversation_id = $1 AND tool = 'purchase_start' AND status = 'pending'", [convId]);
    expect(pending.args.pix_code).toBe(args.pix_code);
    // a pessoa disse "sim": o sistema roda de novo exatamente o que ficou guardado
    const done: any = await purchaseStart.run(pending.args, { ...ctx, approvedAction: true });
    expect(done.ok).toBe(true);
    const charge = calls.find((c) => c.path === "/payments")!;
    expect(charge.body).toMatchObject({ customer: "cus_1", billingType: "CREDIT_CARD", value: 105, creditCardToken: "tok_123", remoteIp: "200.1.2.3" });
    const pay = calls.find((c) => c.path === "/pix/qrCodes/pay")!;
    expect(pay.body).toMatchObject({ qrCode: { payload: args.pix_code }, value: 100 });
    const p = await db.one("SELECT * FROM purchases WHERE pix_tx_id IS NOT NULL ORDER BY created_at DESC LIMIT 1");
    expect(p).toMatchObject({ status: "paid", total_cents: 10_500, fee_cents: 500, method: "card" });
    // validação de saque: aprova só o Pix desta compra com o valor exato
    await db.query("UPDATE purchases SET status = 'paying_store' WHERE id = $1", [p.id]);
    expect((await hook({ type: "PIX_QR_CODE", pixQrCode: { id: p.pix_tx_id, value: 100 } }, "/webhooks/asaas/saque")).json()).toEqual({ status: "APPROVED" });
    expect((await hook({ type: "PIX_QR_CODE", pixQrCode: { id: p.pix_tx_id, value: 101 } }, "/webhooks/asaas/saque")).json()).toMatchObject({ status: "REFUSED" });
    expect((await hook({ type: "TRANSFER", transfer: { id: "x", value: 100 } }, "/webhooks/asaas/saque")).json()).toMatchObject({ status: "REFUSED" });
    expect((await app.inject({ method: "POST", url: "/webhooks/asaas/saque", headers: { "asaas-access-token": "errado" }, payload: {} })).statusCode).toBe(401);
    await db.query("UPDATE purchases SET status = 'paid' WHERE id = $1", [p.id]);
  });

  it("cartão primeira vez: manda o link do Asaas; o webhook salva o token e paga a loja; pagar a loja falhou = estorno", async () => {
    await db.query("UPDATE buyer_profiles SET card_token = NULL, card_last4 = NULL WHERE user_id = $1", [user.id]);
    await fresh();
    decodeCents = 5000;
    const { purchase } = await shop.preparePurchase(user.id, { title: "Mouse", url: "https://shopee.com.br/m", pix_code: code(5000), method: "card" });
    const r = await shop.approvePurchase(user.id, purchase.id);
    expect(r.say).toContain("link seguro do Asaas");
    const p = await row(purchase.id);
    expect(p.status).toBe("charging");
    expect((await outbox()).some((o) => o.text.includes(p.invoice_url))).toBe(true);
    payFails = true;
    const res = await hook({ id: "evt_c1", event: "PAYMENT_CONFIRMED", payment: { id: p.asaas_payment_id, externalReference: `purchase:${p.id}`, creditCard: { creditCardToken: "tok_new", creditCardNumber: "5555", creditCardBrand: "MASTERCARD" } } });
    expect(res.statusCode).toBe(200);
    payFails = false;
    expect((await row(p.id)).status).toBe("refunded");
    expect(calls.some((c) => c.path === `/payments/${p.asaas_payment_id}/refund`)).toBe(true);
    expect(await db.one("SELECT card_last4, card_brand FROM buyer_profiles WHERE user_id = $1", [user.id])).toEqual({ card_last4: "5555", card_brand: "MASTERCARD" });
    // o mesmo evento de novo não faz nada
    expect((await hook({ id: "evt_c1", event: "PAYMENT_CONFIRMED", payment: { id: p.asaas_payment_id, externalReference: `purchase:${p.id}` } })).json()).toMatchObject({ duplicate: true });
  });

  it("saldo: recarga por Pix, reserva, paga a loja e debita; Pix da loja pendente fica para a rodada; recusado devolve", async () => {
    await settings.saveSettings({ purchaseWallet: true });
    await fresh();
    const topup = await shop.createTopup(user, 20_000);
    expect(calls.find((c) => c.path === "/payments")!.body).toMatchObject({ billingType: "PIX", value: 200 });
    await hook({ id: "evt_t1", event: "PAYMENT_RECEIVED", payment: { id: topup!.asaas_payment_id, externalReference: `topup:${topup!.id}` } });
    await hook({ id: "evt_t1b", event: "PAYMENT_CONFIRMED", payment: { id: topup!.asaas_payment_id, externalReference: `topup:${topup!.id}` } });
    expect(await shop.shopWallet(user.id)).toEqual({ balance: 20_000, held: 0 });
    // compra pelo saldo: Pix da loja ainda processando
    decodeCents = 6000;
    pixStatus = "REQUESTED";
    const a = await shop.preparePurchase(user.id, { title: "Livro", url: "https://www.amazon.com.br/l", pix_code: code(6000), method: "wallet" });
    expect(a.purchase).toMatchObject({ fee_cents: 300, total_cents: 6300 });
    await shop.approvePurchase(user.id, a.purchase.id);
    expect((await row(a.purchase.id)).status).toBe("paying_store");
    expect(await shop.shopWallet(user.id)).toEqual({ balance: 13_700, held: 6300 });
    pixStatus = "DONE";
    await shop.checkOpenPurchases();
    expect((await row(a.purchase.id)).status).toBe("paid");
    expect(await shop.shopWallet(user.id)).toEqual({ balance: 13_700, held: 0 });
    // outra: a loja recusou o Pix, o dinheiro volta
    decodeCents = 2000;
    pixStatus = "REFUSED";
    const b = await shop.preparePurchase(user.id, { title: "Caneca", url: "https://www.amazon.com.br/c", pix_code: code(2000), method: "wallet" });
    const r = await shop.approvePurchase(user.id, b.purchase.id);
    expect(r.ok).toBe(false);
    expect((await row(b.purchase.id)).status).toBe("failed");
    expect(await shop.shopWallet(user.id)).toEqual({ balance: 13_700, held: 0 });
    const kinds = (await shop.walletStatement(user.id)).map((e: any) => `${e.kind}:${e.delta_cents}`);
    expect(kinds).toEqual(expect.arrayContaining(["recarga:20000", "reserva:-6300", "reserva:-2290", "devolucao:2290"]));
    // saldo que não cobre: nem pergunta
    decodeCents = 20_000;
    pixStatus = "DONE";
    await expect(shop.preparePurchase(user.id, { title: "TV", url: "https://www.amazon.com.br/tv", pix_code: code(20_000), method: "wallet" })).rejects.toThrow(/Saldo insuficiente/);
  });

  it("limites do dono: por compra e em 30 dias", async () => {
    await fresh();
    await settings.saveSettings({ purchaseMaxCents: 5000, purchaseMonthMaxCents: 30_000 });
    decodeCents = 6000;
    await expect(shop.preparePurchase(user.id, { title: "X", url: "https://www.amazon.com.br/x", pix_code: code(6000), method: "pix" })).rejects.toThrow(/limite por compra/);
    await settings.saveSettings({ purchaseMaxCents: 30_000, purchaseMonthMaxCents: 20_000 });
    decodeCents = 5000;
    // já tem 89,90 + 100 + 60 pagos nos últimos 30 dias
    await expect(shop.preparePurchase(user.id, { title: "X", url: "https://www.amazon.com.br/x", pix_code: code(5000), method: "pix" })).rejects.toThrow(/30 dias/);
    await settings.saveSettings({ purchaseMonthMaxCents: 100_000 });
  });

  it("painel: a pessoa vê os dados dela, e o dono vê só números e as compras", async () => {
    const { buyerProfile } = shop;
    const prof = await buyerProfile(user.id);
    expect(prof).toMatchObject({ filled: true, cpf_end: "25", terms: { accepted: true }, card: { last4: "5555" } });
    // editar sem redigitar o CPF mantém o que estava
    await shop.saveBuyerProfile(user.id, { full_name: "Carla Dias", cpf: "", birth_date: "1990-05-10", address: { cep: "13010000", street: "Rua B", number: "20", district: "Centro", city: "Campinas", state: "SP" } });
    expect(await buyerProfile(user.id)).toMatchObject({ cpf_end: "25", address: { street: "Rua B" } });
    // o banco não tem o CPF em texto
    const raw = await db.one("SELECT data FROM buyer_profiles WHERE user_id = $1", [user.id]);
    expect(raw.data).not.toContain("52998224725");
    const ov = await shop.purchasesOverview();
    expect(ov.month.paid).toBeGreaterThanOrEqual(2);
    expect(ov.wallets).toEqual({ balance: 13_700, held: 0 });
    const cfg = (await app.inject({ method: "GET", url: "/api/auth/config" })).json();
    expect(cfg.purchases).toMatchObject({ enabled: true, methods: { pix: true, card: true, wallet: true }, feePercent: 5 });
  });
});
