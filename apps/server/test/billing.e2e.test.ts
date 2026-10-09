import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Grãos (créditos) e planos pelo Asaas: carteira, desconto do uso, trava, pacotes, planos, troca, indicação e webhook. */
describe("assinatura: regras sem banco", () => {
  it("valida CPF e CNPJ pelos dígitos verificadores", async () => {
    const { validCpfCnpj } = await import("../src/billing.js");
    expect(validCpfCnpj("529.982.247-25")).toBe(true);
    expect(validCpfCnpj("52998224725")).toBe(true);
    expect(validCpfCnpj("529.982.247-26")).toBe(false);
    expect(validCpfCnpj("111.111.111-11")).toBe(false);
    expect(validCpfCnpj("11.222.333/0001-81")).toBe(true);
    expect(validCpfCnpj("11.222.333/0001-82")).toBe(false);
    expect(validCpfCnpj("123")).toBe(false);
  });

  it("chave de produção fala com a API real; qualquer outra, com o sandbox", async () => {
    const { asaasBase } = await import("../src/billing.js");
    expect(asaasBase("$aact_prod_abc")).toBe("https://api.asaas.com/v3");
    expect(asaasBase("$aact_hmlg_abc")).toBe("https://api-sandbox.asaas.com/v3");
  });

  it("vitrine do painel: planos e pacotes validados, grão do plano sempre mais barato que o avulso no padrão", async () => {
    const { cleanPlans, cleanPacks, DEFAULT_PLANS, DEFAULT_PACKS } = await import("../src/settings.js");
    expect(() => cleanPlans([])).toThrow(/pelo menos um plano/);
    expect(() => cleanPlans([{ name: "X", price: 0.5, grains: 10 }])).toThrow(/entre R\$ 1/);
    expect(() => cleanPlans([{ name: "A", price: 10, grains: 10 }, { name: "a", price: 20, grains: 20 }])).toThrow(/mesmo nome/);
    expect(cleanPlans([{ name: "Família Plus", price: "29.999", grains: "3000.4" }])).toEqual([{ id: "familia-plus", name: "Família Plus", price: 30, grains: 3000, blurb: "", highlight: false }]);
    expect(cleanPacks([{ grains: 900, price: 15 }, { grains: 100, price: 2 }]).map((p) => p.id)).toEqual(["p100", "p900"]);
    const worstPlan = Math.max(...DEFAULT_PLANS.map((p) => p.price / p.grains));
    const bestPack = Math.min(...DEFAULT_PACKS.map((p) => p.price / p.grains));
    expect(worstPlan).toBeLessThan(bestPack);
  });

  it("grãos: custo real em dólar vira grão arredondado para cima; desconto de indicação em centavos certos", async () => {
    const { grainsForCost, grains } = await import("../src/credits.js");
    const { withDiscount } = await import("../src/billing.js");
    const s = { billingGrainsPerUsd: 1000 } as any;
    expect(grainsForCost(0, s)).toBe(0);
    expect(grainsForCost(0.0001, s)).toBe(1);
    expect(grainsForCost(0.05, s)).toBe(50);
    expect(grainsForCost(0.0501, s)).toBe(51);
    expect(grains(1)).toBe("1 grão");
    expect(grains(4000)).toBe("4.000 grãos");
    expect(withDiscount(19.9, 5)).toBe(18.9);
    expect(withDiscount(19.9, 10)).toBe(17.91);
    expect(withDiscount(39.9, 0)).toBe(39.9);
  });

  it("próxima mensalidade: mesmo dia no mês seguinte, ou o último dia quando o mês é mais curto", async () => {
    const { addMonth } = await import("../src/billing.js");
    expect(addMonth("2026-01-15")).toBe("2026-02-15");
    expect(addMonth("2026-01-31")).toBe("2026-02-28");
    expect(addMonth("2028-01-31")).toBe("2028-02-29");
    expect(addMonth("2026-03-31")).toBe("2026-04-30");
    expect(addMonth("2026-12-31")).toBe("2027-01-31");
  });
});

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("grãos e planos pelo Asaas (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let billing: typeof import("../src/billing.js");
  let credits: typeof import("../src/credits.js");
  let settings: typeof import("../src/settings.js");
  let user: any;
  let convId: string;
  let app: any;
  const realFetch = globalThis.fetch;
  const asaasCalls: { method: string; path: string; body: any }[] = [];
  const TOKEN = "token-do-webhook-bem-comprido";
  let payN = 0;
  let subN = 0;
  let paymentsEmptyOnce = false;
  const reloadUser = async () => (user = await db.one("SELECT * FROM users WHERE id = $1", [user.id]));
  const wallet = async (id = user.id) => db.one("SELECT plan_grains, extra_grains FROM wallets WHERE user_id = $1", [id]);
  const outbox = async () => (await db.many("SELECT data FROM pgboss.job WHERE name = 'outbound.send' ORDER BY created_on")).map((r) => r.data);
  const hook = (body: unknown, token = TOKEN) => app.inject({ method: "POST", url: "/webhooks/asaas", headers: { "asaas-access-token": token }, payload: body as any });

  beforeAll(async () => {
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (!u.includes("asaas.com")) return realFetch(url, init);
      const path = u.replace(/^https:\/\/[^/]+\/v3/, "");
      const method = init?.method ?? "GET";
      asaasCalls.push({ method, path, body: init?.body ? JSON.parse(init.body) : null });
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (path === "/customers") return json({ id: "cus_1" });
      if (path === "/subscriptions" && method === "POST") return json({ id: `sub_${++subN}` });
      const subPayments = path.match(/^\/subscriptions\/(sub_\d+)\/payments$/);
      if (subPayments) {
        if (paymentsEmptyOnce) {
          paymentsEmptyOnce = false;
          return json({ data: [] });
        }
        const id = subPayments[1] === "sub_1" ? "pay_1" : `pay_${subPayments[1]}`;
        const today = new Date().toISOString().slice(0, 10);
        // fora de ordem de propósito: vale a primeira em aberto pela data
        return json({
          data: [
            { id: "pay_later", status: "PENDING", dueDate: "2099-01-01", invoiceUrl: "https://sandbox.asaas.com/i/pay_later" },
            { id: "pay_old", status: "RECEIVED", dueDate: "2000-01-01", invoiceUrl: "https://sandbox.asaas.com/i/pay_old" },
            { id, status: "PENDING", dueDate: today, invoiceUrl: `https://sandbox.asaas.com/i/${id}` },
          ],
        });
      }
      if (path === "/payments" && method === "POST") {
        payN++;
        return json({ id: `pay_av_${payN}`, invoiceUrl: `https://sandbox.asaas.com/i/pay_av_${payN}` });
      }
      return json({ ok: true });
    }) as typeof fetch;
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    billing = await import("../src/billing.js");
    credits = await import("../src/credits.js");
    settings = await import("../src/settings.js");
    const { saveCredentials } = await import("../src/integrations/registry.js");
    await saveCredentials("asaas", { api_key: "$aact_hmlg_teste", webhook_token: TOKEN });
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    user = await upsertUser("5519944440000", "Carla");
    await db.query("UPDATE users SET status = 'active', full_name = 'Carla Dias' WHERE id = $1", [user.id]);
    await reloadUser();
    convId = (await upsertConversation(user.id, "playground", "jid-carla")).id;
    app = await (await import("../src/api/server.js")).buildServer();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await app?.close();
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  it("desligada ninguém gasta grão; ligada, cada pessoa ganha as boas-vindas uma vez só", async () => {
    expect(await billing.billingAccess(user)).toEqual({ allowed: true, state: "off" });
    expect(await credits.chargeUsage(user.id, 0.5)).toBeNull();
    const s = await settings.saveSettings({ billingEnabled: true });
    expect(s.billingStartedAt).toBeTruthy();
    expect(await billing.billingAccess(user)).toEqual({ allowed: true, state: "grains", balance: 300 });
    expect(await credits.ensureWallet(user.id)).toEqual({ plan: 0, extra: 300, total: 300 });
    // várias chamadas ao mesmo tempo na primeira vez: todas veem as boas-vindas, uma vez só no extrato
    const { upsertUser } = await import("../src/ingest.js");
    const dani = await upsertUser("5519933330000", "Dani");
    const firsts = await Promise.all(Array.from({ length: 6 }, () => credits.ensureWallet(dani.id)));
    expect(firsts.map((w) => w.total)).toEqual([300, 300, 300, 300, 300, 300]);
    expect(await db.many("SELECT delta FROM grain_ledger WHERE user_id = $1", [dani.id])).toEqual([{ delta: 300 }]);
    // apagar a carteira não dá as boas-vindas de novo
    await db.query("DELETE FROM wallets WHERE user_id = $1", [user.id]);
    expect((await credits.ensureWallet(user.id)).total).toBe(0);
    await credits.creditGrains(user.id, { amount: 300, bucket: "extra", reason: "ajuste", ref: "volta-teste" });
    // a vitrine pública vai para a landing mesmo sem login
    const cfg = (await app.inject({ method: "GET", url: "/api/auth/config" })).json();
    expect(cfg.pricing).toMatchObject({ enabled: true, welcome: 300, plans: [{ id: "leve" }, { id: "dia-a-dia", highlight: true }, { id: "completo" }], referral: { step: 5, max: 30 } });
  });

  it("o uso desconta pelo custo real, soma no extrato do dia, avisa quando está acabando e quando zera", async () => {
    await db.query("DELETE FROM pgboss.job WHERE name = 'outbound.send'");
    const { Tracer } = await import("../src/agent/trace.js");
    // a reunião noturna é da plataforma: o custo conta no uso do dia, mas não sai da carteira
    const nightly = await Tracer.start({ trigger: "improve", userId: user.id, input: "teste", noCharge: true });
    await (await nightly.step({ agent: "cto", type: "llm", name: "reunião" })).ok({}, { model: "x", tokensIn: 10, tokensOut: 10, costUsd: 0.2 });
    await new Promise((r) => setTimeout(r, 100));
    expect(Number((await wallet()).extra_grains)).toBe(300);
    expect(Number((await db.one("SELECT cost_usd FROM usage_daily WHERE user_id = $1", [user.id])).cost_usd)).toBeCloseTo(0.2);
    expect(await credits.chargeUsage(user.id, 0.05)).toEqual({ charged: 50, left: 250 });
    // o passo do Tracer com custo também desconta (sem travar a resposta)
    const tracer = await Tracer.start({ trigger: "message", userId: user.id, conversationId: convId, input: "teste" });
    const step = await tracer.step({ agent: "cto", type: "llm", name: "teste" });
    await step.ok({}, { model: "x", tokensIn: 10, tokensOut: 10, costUsd: 0.1 });
    await tracer.finish("ok");
    await expect.poll(async () => Number((await wallet()).extra_grains)).toBe(150);
    expect(await db.many("SELECT delta, reason FROM grain_ledger WHERE user_id = $1 AND reason = 'uso'", [user.id])).toEqual([{ delta: -150, reason: "uso" }]);
    expect(await outbox()).toEqual([]);
    // cruzou a linha (100 sem plano): um aviso só
    await credits.chargeUsage(user.id, 0.06);
    await credits.chargeUsage(user.id, 0.01);
    let sent = await outbox();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/grãos estão acabando: sobraram 90 grãos[\s\S]*\/plano$/);
    // zerou: nunca fica negativo, avisa na hora
    expect(await credits.chargeUsage(user.id, 5)).toEqual({ charged: 5000, left: 0 });
    expect(await wallet()).toEqual({ plan_grains: 0, extra_grains: 0 });
    sent = await outbox();
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toMatch(/grãos acabaram[\s\S]*\/plano$/);
    expect(await billing.billingAccess(user)).toEqual({ allowed: false, state: "empty", balance: 0 });
  });

  it("carteira zerada: o assistente não chama a IA e avisa no máximo uma vez por dia", async () => {
    const channels = await import("../src/channels/index.js");
    const { processConversation } = await import("../src/agent/orchestrator.js");
    const say = async (text: string, id: string) => {
      await db.query("INSERT INTO messages (conversation_id, role, content, external_id) VALUES ($1, 'user', $2, $3)", [convId, text, id]);
      const channel = new channels.PlaygroundChannel();
      const r = await processConversation(convId, { trigger: "message", channel });
      return { channel, r };
    };
    // o aviso de zerado acabou de sair pelo desconto: a primeira mensagem já fica em silêncio
    const first = await say("oi, anota um gasto de 10 reais", "b1");
    expect(first.channel.sent).toEqual([]);
    expect(await db.many("SELECT type, name FROM execution_steps WHERE execution_id = $1", [first.r.executionId])).toEqual([{ type: "info", name: "trava: grãos" }]);
    // no dia seguinte avisa de novo com o link
    await db.query("UPDATE users SET profile = profile - 'billing_notice_at' WHERE id = $1", [user.id]);
    const next = await say("oi?", "b2");
    expect(next.channel.sent).toHaveLength(1);
    expect(next.channel.sent[0]!.text).toMatch(/grãos acabaram[\s\S]*\/plano$/);
    expect((await say("alô", "b3")).channel.sent).toEqual([]);

    // lembrete sai com o texto pronto, sem IA; automação sem texto pronto fica em silêncio
    const steps = async (id: string | null) => (await db.many("SELECT name FROM execution_steps WHERE execution_id = $1", [id])).map((r) => r.name);
    const remind = new channels.PlaygroundChannel();
    const r1 = await processConversation(convId, { trigger: "reminder", event: "Lembrete agendado: pagar a luz", plainText: "Lembrete: pagar a luz", channel: remind });
    expect(remind.sent.map((m: any) => m.text)).toEqual(["Lembrete: pagar a luz"]);
    expect(await steps(r1.executionId)).toEqual(["trava: grãos (lembrete sem IA)"]);
    const auto = new channels.PlaygroundChannel();
    const r2 = await processConversation(convId, { trigger: "reminder", event: "Uma automação disparou", channel: auto });
    expect(auto.sent).toEqual([]);
    expect(await steps(r2.executionId)).toEqual(["trava: grãos"]);
    // recado: o estabelecimento respondeu, mas sem grãos o agente de recados não roda
    const errand = await db.one(
      `INSERT INTO errands (user_id, conversation_id, place, phone, jid, goal, log, expires_at)
       VALUES ($1, $2, 'Barbearia', '5519900000000', '5519900000000@s.whatsapp.net', 'marcar corte', $3, now() + interval '1 day') RETURNING id`,
      [user.id, convId, JSON.stringify([{ from: "eles", text: "tenho às 15h" }])],
    );
    const { runErrandTurn } = await import("../src/agent/errand-agent.js");
    expect(await runErrandTurn(errand.id)).toBeNull();
    expect(await db.one("SELECT status FROM errands WHERE id = $1", [errand.id])).toEqual({ status: "waiting" });
  });

  it("pacote avulso: cobrança no Asaas com referência própria, entra uma vez só quando paga e destrava", async () => {
    await expect(billing.buyPack(user, "p500", { name: "Carla", cpfCnpj: "529.982.247-25" })).rejects.toThrow(/nome completo/);
    await expect(billing.buyPack(user, "p500", { name: "Carla Dias", cpfCnpj: "123.456.789-00" })).rejects.toThrow(/CPF ou CNPJ inválido/);
    await expect(billing.buyPack(user, "nao-existe")).rejects.toThrow(/Pacote não encontrado/);
    expect(asaasCalls).toEqual([]);
    const p = await billing.buyPack(user, "p500", { name: "Carla Dias", cpfCnpj: "529.982.247-25", email: "carla@x.com" });
    expect(asaasCalls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /customers", "POST /payments"]);
    expect(asaasCalls[0]!.body).toMatchObject({ name: "Carla Dias", cpfCnpj: "52998224725", mobilePhone: "19944440000", externalReference: user.id });
    expect(asaasCalls[1]!.body).toMatchObject({ customer: "cus_1", billingType: "UNDEFINED", value: 9.9, externalReference: `grains:${p.id}` });
    // o CPF vai para o Asaas e não fica aqui
    expect(JSON.stringify(await db.many("SELECT * FROM subscriptions"))).not.toContain("52998224725");
    // pedir de novo reaproveita a cobrança em aberto
    expect((await billing.buyPack(user, "p500")).id).toBe(p.id);
    expect(asaasCalls).toHaveLength(2);

    expect((await hook({ id: "e1", event: "PAYMENT_CONFIRMED", payment: { id: "pay_av_1", externalReference: `grains:${p.id}` } }, "errado")).statusCode).toBe(401);
    expect((await hook({ id: "e1", event: "PAYMENT_CONFIRMED", payment: { id: "pay_av_1", externalReference: `grains:${p.id}`, billingType: "PIX" } })).json()).toEqual({ ok: true, handled: true, status: "paid" });
    // cartão manda RECEIVED do mesmo pagamento depois, com outro id de evento: não credita de novo
    await hook({ id: "e2", event: "PAYMENT_RECEIVED", payment: { id: "pay_av_1", externalReference: `grains:${p.id}` } });
    expect(await wallet()).toEqual({ plan_grains: 0, extra_grains: 500 });
    expect((await outbox()).at(-1).text).toMatch(/Entraram 500 grãos e agora você tem 500 grãos/);
    expect(await billing.billingAccess(user)).toMatchObject({ allowed: true, state: "grains", balance: 500 });
    // referência que não é nossa: aceita e ignora
    expect((await hook({ event: "PAYMENT_RECEIVED", payment: { id: "x", externalReference: "outra-coisa" } })).json()).toEqual({ ok: true, handled: false });
  });

  it("plano no cartão: recarrega os grãos a cada mês pago (sem acumular) e guarda só o final do cartão", async () => {
    asaasCalls.length = 0;
    await expect(billing.subscribe(user, { planId: "nao-existe" })).rejects.toThrow(/Plano não encontrado/);
    const sub = await billing.subscribe(user, { planId: "dia-a-dia", method: "card" });
    expect(asaasCalls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /subscriptions", "GET /subscriptions/sub_1/payments"]);
    expect(asaasCalls[0]!.body).toMatchObject({ customer: "cus_1", billingType: "CREDIT_CARD", cycle: "MONTHLY", value: 39.9, description: "Planejai Dia a dia (4.000 grãos por mês)" });
    expect(sub).toMatchObject({ status: "trial", plan_id: "dia-a-dia", pay_method: "card", invoice_url: "https://sandbox.asaas.com/i/pay_1" });

    const due = new Date().toISOString().slice(0, 10);
    const card = { creditCardNumber: "4242", creditCardBrand: "VISA" };
    expect((await hook({ id: "s1", event: "PAYMENT_CONFIRMED", payment: { id: "pay_1", subscription: "sub_1", value: 39.9, dueDate: due, billingType: "CREDIT_CARD", creditCard: card } })).json()).toEqual({ ok: true, handled: true, status: "active" });
    await hook({ id: "s2", event: "PAYMENT_RECEIVED", payment: { id: "pay_1", subscription: "sub_1", value: 39.9, dueDate: due, billingType: "CREDIT_CARD" } });
    expect(await wallet()).toEqual({ plan_grains: 4000, extra_grains: 500 });
    expect(await db.one("SELECT status, card_brand, card_last4 FROM subscriptions WHERE user_id = $1", [user.id])).toEqual({ status: "active", card_brand: "VISA", card_last4: "4242" });
    expect((await outbox()).at(-1).text).toMatch(/obrigado por assinar o Dia a dia! Já coloquei 4.000 grãos/);
    // o uso sai primeiro do plano
    await credits.chargeUsage(user.id, 1);
    expect(await wallet()).toEqual({ plan_grains: 3000, extra_grains: 500 });
    // mês seguinte: o plano volta para 4.000 (o que sobrou não acumula); os extras ficam
    await hook({ id: "s3", event: "PAYMENT_CONFIRMED", payment: { id: "pay_2", subscription: "sub_1", value: 39.9, dueDate: due, billingType: "CREDIT_CARD" } });
    expect(await wallet()).toEqual({ plan_grains: 4000, extra_grains: 500 });
    expect((await outbox()).at(-1).text).toMatch(/Recebi a mensalidade[\s\S]*4.000 grãos/);
  });

  it("subir de plano paga a diferença e ganha os grãos na hora; descer vale da próxima mensalidade", async () => {
    asaasCalls.length = 0;
    const up = await billing.changePlan(user, "completo");
    expect(up.kind).toBe("upgrade");
    const charge = asaasCalls.find((c) => c.path === "/payments");
    expect(charge?.body).toMatchObject({ value: 40, description: expect.stringContaining("+6.000 grãos") });
    const purchase = await db.one("SELECT id FROM grain_purchases WHERE kind = 'upgrade'");
    await hook({ id: "u1", event: "PAYMENT_CONFIRMED", payment: { id: "pay_av_2", externalReference: `grains:${purchase.id}` } });
    expect(await wallet()).toEqual({ plan_grains: 10000, extra_grains: 500 });
    expect(await db.one("SELECT plan_id, value::float AS value FROM subscriptions WHERE user_id = $1", [user.id])).toEqual({ plan_id: "completo", value: 79.9 });
    expect(asaasCalls.at(-1)).toMatchObject({ method: "POST", path: "/subscriptions/sub_1", body: { value: 79.9, updatePendingPayments: true } });

    const down = await billing.changePlan(user, "leve");
    expect(down.kind).toBe("downgrade");
    expect(await db.one("SELECT plan_id, next_plan_id, value::float AS value FROM subscriptions WHERE user_id = $1", [user.id])).toEqual({ plan_id: "completo", next_plan_id: "leve", value: 19.9 });
    // os grãos deste mês ficam; na próxima mensalidade entra o plano leve
    expect((await wallet()).plan_grains).toBe(10000);
    await hook({ id: "s4", event: "PAYMENT_CONFIRMED", payment: { id: "pay_3", subscription: "sub_1", value: 19.9, billingType: "CREDIT_CARD" } });
    expect(await wallet()).toEqual({ plan_grains: 1500, extra_grains: 500 });
    expect(await db.one("SELECT plan_id, next_plan_id FROM subscriptions WHERE user_id = $1", [user.id])).toEqual({ plan_id: "leve", next_plan_id: null });
  });

  it("pagamento atrasado do cartão ou de mês antigo não volta o plano para em dia nem apaga o link da cobrança nova", async () => {
    const d1 = (await billing.getSubscription(user.id))!.paid_until!;
    const d2 = billing.addMonth(d1);
    const row = () => db.one("SELECT status, invoice_url, to_char(paid_until, 'YYYY-MM-DD') AS paid_until FROM subscriptions WHERE user_id = $1", [user.id]);
    await hook({ id: "l1", event: "PAYMENT_CREATED", payment: { id: "pay_4", subscription: "sub_1", status: "PENDING", value: 19.9, dueDate: d1, invoiceUrl: "https://sandbox.asaas.com/i/pay_4" } });
    await hook({ id: "l2", event: "PAYMENT_OVERDUE", payment: { id: "pay_4", subscription: "sub_1", status: "OVERDUE", value: 19.9, dueDate: d1, invoiceUrl: "https://sandbox.asaas.com/i/pay_4" } });
    expect(await row()).toEqual({ status: "overdue", invoice_url: "https://sandbox.asaas.com/i/pay_4", paid_until: d1 });
    await db.query("UPDATE wallets SET plan_grains = 100 WHERE user_id = $1", [user.id]);
    // o cartão do mês passado liquida (RECEIVED) só agora: já foi creditado no CONFIRMED, nada muda
    expect((await hook({ id: "l3", event: "PAYMENT_RECEIVED", payment: { id: "pay_3", subscription: "sub_1", value: 19.9, billingType: "CREDIT_CARD" } })).json()).toMatchObject({ status: "overdue" });
    expect(await row()).toEqual({ status: "overdue", invoice_url: "https://sandbox.asaas.com/i/pay_4", paid_until: d1 });
    expect((await wallet()).plan_grains).toBe(100);
    // a cobrança seguinte nasce antes de a atrasada ser paga: o link novo fica
    await hook({ id: "l4", event: "PAYMENT_CREATED", payment: { id: "pay_5", subscription: "sub_1", status: "PENDING", value: 19.9, dueDate: d2, invoiceUrl: "https://sandbox.asaas.com/i/pay_5" } });
    await hook({ id: "l5", event: "PAYMENT_RECEIVED", payment: { id: "pay_4", subscription: "sub_1", value: 19.9, dueDate: d1, billingType: "PIX", invoiceUrl: "https://sandbox.asaas.com/i/pay_4" } });
    expect(await row()).toEqual({ status: "active", invoice_url: "https://sandbox.asaas.com/i/pay_5", paid_until: d2 });
    expect((await wallet()).plan_grains).toBe(1500);
    // mensalidade de um mês que já passou, paga agora: não volta a data nem recarrega de novo
    await db.query("UPDATE wallets SET plan_grains = 100 WHERE user_id = $1", [user.id]);
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
    await hook({ id: "l6", event: "PAYMENT_RECEIVED", payment: { id: "pay_0", subscription: "sub_1", value: 19.9, dueDate: old, billingType: "PIX" } });
    expect(await row()).toEqual({ status: "active", invoice_url: "https://sandbox.asaas.com/i/pay_5", paid_until: d2 });
    expect((await wallet()).plan_grains).toBe(100);
    await db.query("UPDATE wallets SET plan_grains = 1500 WHERE user_id = $1", [user.id]);
  });

  it("indicação: cada amigo pagando dá mais desconto na mensalidade de quem convidou, até o teto", async () => {
    await db.query("DELETE FROM pgboss.job WHERE name = 'outbound.send'");
    asaasCalls.length = 0;
    const { upsertUser } = await import("../src/ingest.js");
    const ana = await upsertUser("5519955550000", "Ana");
    const beto = await upsertUser("5519966660000", "Beto");
    const caio = await upsertUser("5519977770000", "Caio");
    await db.query("UPDATE users SET status = 'active', full_name = name WHERE id = ANY($1)", [[ana.id, beto.id, caio.id]]);
    await db.query("UPDATE users SET invited_by = $1 WHERE id = ANY($2)", [ana.id, [beto.id, caio.id]]);
    await db.query(
      `INSERT INTO subscriptions (user_id, asaas_customer_id, asaas_subscription_id, status, value, plan_id, next_due_date, last_payment_at) VALUES
        ($1, 'cus_a', 'sub_ana', 'active', 19.9, 'leve', '2026-12-01', now()), ($2, 'cus_b', 'sub_beto', 'trial', 19.9, 'leve', CURRENT_DATE, NULL),
        ($3, 'cus_c', 'sub_caio', 'trial', 19.9, 'leve', CURRENT_DATE, NULL)`,
      [ana.id, beto.id, caio.id],
    );
    const evt = { id: "r1", event: "PAYMENT_CONFIRMED", payment: { id: "pay_b1", subscription: "sub_beto", value: 19.9, billingType: "PIX" } };
    expect(await billing.handleAsaasEvent(evt)).toMatchObject({ handled: true, status: "active" });
    expect(await billing.handleAsaasEvent(evt)).toMatchObject({ duplicate: true });
    expect(asaasCalls.find((c) => c.path === "/subscriptions/sub_ana")?.body).toMatchObject({ value: 18.9, updatePendingPayments: true });
    expect((await outbox()).find((m: any) => m.userId === ana.id).text).toMatch(/Beto assinou pelo seu convite! Agora são 1 amigo[\s\S]*5% de desconto/);

    await billing.handleAsaasEvent({ id: "r2", event: "PAYMENT_CONFIRMED", payment: { id: "pay_c1", subscription: "sub_caio", value: 19.9 } });
    expect(await db.one("SELECT discount_percent, value::float AS value FROM subscriptions WHERE user_id = $1", [ana.id])).toEqual({ discount_percent: 10, value: 17.91 });
    // teto: com passo de 50% o desconto para em 30%
    await settings.saveSettings({ billingReferralStep: 50 });
    expect(await billing.referralDiscount(ana.id)).toMatchObject({ friends: 2, percent: 30 });
    await settings.saveSettings({ billingReferralStep: 5 });
    // amigo atrasou: o desconto volta um passo
    await billing.handleAsaasEvent({ id: "r3", event: "PAYMENT_OVERDUE", payment: { id: "pay_b2", subscription: "sub_beto", value: 19.9, invoiceUrl: "https://sandbox.asaas.com/i/pay_b2" } });
    expect(await db.one("SELECT discount_percent, value::float AS value FROM subscriptions WHERE user_id = $1", [ana.id])).toEqual({ discount_percent: 5, value: 18.9 });
    expect((await outbox()).find((m: any) => m.userId === beto.id && /pay_b2/.test(m.text))).toBeTruthy();

    // lembrete de vencimento: assinatura Pix/boleto ouve antes (mesmo tendo pago um mês no cartão); assinatura no cartão não
    await db.query("DELETE FROM pgboss.job WHERE name = 'outbound.send'");
    await db.query("UPDATE subscriptions SET status = 'active', next_due_date = (now() AT TIME ZONE 'America/Sao_Paulo')::date + 3, pay_method = 'pix', last_billing_type = 'CREDIT_CARD', reminded_on = NULL WHERE user_id = $1", [beto.id]);
    await db.query("UPDATE subscriptions SET next_due_date = (now() AT TIME ZONE 'America/Sao_Paulo')::date + 3, pay_method = 'card', last_billing_type = 'CREDIT_CARD' WHERE user_id = ANY($1)", [[ana.id, caio.id]]);
    expect((await billing.billingReminders()).due).toBe(1);
    expect((await outbox())[0]).toMatchObject({ userId: beto.id, text: expect.stringMatching(/vence a sua mensalidade de R\$ 19,90/) });
    expect((await billing.billingReminders()).due).toBe(0);
  });

  it("cancelar mantém os grãos que sobraram; liberado pelo dono não gasta nada", async () => {
    await billing.cancelSubscription(user.id);
    expect(asaasCalls.at(-1)).toMatchObject({ method: "DELETE", path: "/subscriptions/sub_1" });
    expect(await wallet()).toEqual({ plan_grains: 1500, extra_grains: 500 });
    await db.query("UPDATE users SET billing_exempt = true WHERE id = $1", [user.id]);
    expect(await billing.billingAccess(await reloadUser())).toEqual({ allowed: true, state: "exempt" });
    expect(await credits.chargeUsage(user.id, 1)).toBeNull();
    const o = await billing.billingOverview();
    expect(o.counts).toMatchObject({ exempt: 1 });
    expect(o.mrr).toBeGreaterThan(0);
    // avulsos do mês: pacote + diferença da troca de plano
    expect(o.packsMonth).toBe(49.9);
  });

  it("assinar de novo começa do zero; primeira mensalidade sem pagar avisa o atraso uma vez e deixa assinar de novo", async () => {
    await db.query("DELETE FROM pgboss.job WHERE name = 'outbound.send'");
    asaasCalls.length = 0;
    const sub = await billing.subscribe(user, { planId: "leve", method: "pix" });
    expect(sub).toMatchObject({ status: "trial", asaas_subscription_id: "sub_2", invoice_url: "https://sandbox.asaas.com/i/pay_sub_2", pay_method: "pix" });
    expect(await db.one("SELECT last_payment_at, last_billing_type, card_brand, card_last4, reminded_on FROM subscriptions WHERE user_id = $1", [user.id])).toEqual({
      last_payment_at: null,
      last_billing_type: null,
      card_brand: null,
      card_last4: null,
      reminded_on: null,
    });
    // venceu sem pagar: avisa uma vez; a cobrança vencida do mês seguinte só atualiza o link
    await hook({ id: "n1", event: "PAYMENT_OVERDUE", payment: { id: "pay_sub_2", subscription: "sub_2", value: 19.9, invoiceUrl: "https://sandbox.asaas.com/i/pay_sub_2" } });
    await hook({ id: "n2", event: "PAYMENT_OVERDUE", payment: { id: "pay_sub_2b", subscription: "sub_2", value: 19.9, invoiceUrl: "https://sandbox.asaas.com/i/pay_sub_2b" } });
    expect((await outbox()).filter((m: any) => /venceu/.test(m.text))).toHaveLength(1);
    expect(await db.one("SELECT status, invoice_url FROM subscriptions WHERE user_id = $1", [user.id])).toEqual({ status: "overdue", invoice_url: "https://sandbox.asaas.com/i/pay_sub_2b" });
    // cartão recusado: avisa com o link para pagar de outro jeito, sem mudar a situação
    await hook({ id: "n2r", event: "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED", payment: { id: "pay_sub_2b", subscription: "sub_2", value: 19.9, invoiceUrl: "https://sandbox.asaas.com/i/pay_sub_2b" } });
    await hook({ id: "n2s", event: "PAYMENT_REPROVED_BY_RISK_ANALYSIS", payment: { id: "pay_sub_2b", subscription: "sub_2", value: 19.9, invoiceUrl: "https://sandbox.asaas.com/i/pay_sub_2b" } });
    const refused = (await outbox()).filter((m: any) => /cartão não passou/.test(m.text));
    expect(refused).toHaveLength(2);
    expect(refused[0].text).toMatch(/Pix ou boleto aqui: https:\/\/sandbox.asaas.com\/i\/pay_sub_2b$/);
    expect(await db.one("SELECT status FROM subscriptions WHERE user_id = $1", [user.id])).toEqual({ status: "overdue" });
    // nunca pagou: pode assinar de novo; a assinatura velha sai do Asaas (e o Asaas pode demorar um instante para gerar a cobrança)
    asaasCalls.length = 0;
    paymentsEmptyOnce = true;
    const again = await billing.subscribe(user, { planId: "dia-a-dia", method: "card" });
    expect(asaasCalls.map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /subscriptions/sub_2", "POST /subscriptions", "GET /subscriptions/sub_3/payments", "GET /subscriptions/sub_3/payments"]);
    expect(again).toMatchObject({ status: "trial", asaas_subscription_id: "sub_3", plan_id: "dia-a-dia", invoice_url: "https://sandbox.asaas.com/i/pay_sub_3" });
    // o Asaas avisa que apagou a velha: não é mais a nossa, nada muda
    expect((await hook({ id: "n3", event: "SUBSCRIPTION_DELETED", subscription: { id: "sub_2" } })).json()).toMatchObject({ handled: false });
    // depois de pagar a primeira, assinar de novo volta a ser recusado
    await hook({ id: "n4", event: "PAYMENT_CONFIRMED", payment: { id: "pay_sub_3", subscription: "sub_3", value: 39.9, billingType: "CREDIT_CARD" } });
    await expect(billing.subscribe(user, { planId: "leve" })).rejects.toThrow(/já tem um plano/);
  });
});
