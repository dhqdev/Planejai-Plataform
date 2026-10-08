import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Assinatura pelo Asaas: dias grátis, trava do assistente, assinatura criada no Asaas e avisos de pagamento pelo webhook. */
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
});

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("assinatura pelo Asaas (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let billing: typeof import("../src/billing.js");
  let settings: typeof import("../src/settings.js");
  let user: any;
  let convId: string;
  const realFetch = globalThis.fetch;
  const asaasCalls: { method: string; path: string; body: any }[] = [];
  const TOKEN = "token-do-webhook-bem-comprido";
  const reloadUser = async () => (user = await db.one("SELECT * FROM users WHERE id = $1", [user.id]));
  /** os dias grátis contam de quando a cobrança foi ligada: volta essa data no tempo */
  const startedDaysAgo = async (days: number) => {
    await db.query("INSERT INTO settings (key, value) VALUES ('billingStartedAt', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify(new Date(Date.now() - days * 86_400_000).toISOString())]);
    await settings.saveSettings({});
  };

  beforeAll(async () => {
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (!u.includes("asaas.com")) return realFetch(url, init);
      const path = u.replace(/^https:\/\/[^/]+\/v3/, "");
      asaasCalls.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(init.body) : null });
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (path === "/customers") return json({ id: "cus_1" });
      if (path === "/subscriptions") return json({ id: "sub_1" });
      if (path === "/subscriptions/sub_1/payments") return json({ data: [{ id: "pay_1", invoiceUrl: "https://sandbox.asaas.com/i/pay_1" }] });
      if (path.startsWith("/payments?subscription=sub_ana")) return json({ data: [{ id: "pay_ana_2", value: 19.9, dueDate: "2026-12-01", billingType: "UNDEFINED" }] });
      if (path.startsWith("/payments/")) return json({ id: path.split("/")[2] });
      return json({ deleted: true });
    }) as typeof fetch;
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    billing = await import("../src/billing.js");
    settings = await import("../src/settings.js");
    const { saveCredentials } = await import("../src/integrations/registry.js");
    await saveCredentials("asaas", { api_key: "$aact_hmlg_teste", webhook_token: TOKEN });
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    user = await upsertUser("5519944440000", "Carla");
    await db.query("UPDATE users SET status = 'active', full_name = 'Carla Dias' WHERE id = $1", [user.id]);
    await reloadUser();
    convId = (await upsertConversation(user.id, "playground", "jid-carla")).id;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  it("desligada não cobra ninguém; ligada, quem já era cliente ganha os dias grátis a partir de agora", async () => {
    expect(await billing.billingAccess(user)).toEqual({ allowed: true, state: "off" });
    // a pessoa entrou há um mês: se os dias contassem da entrada, travaria no instante em que o dono liga
    await db.query("UPDATE users SET created_at = now() - interval '30 days', terms_accepted_at = now() - interval '30 days' WHERE id = $1", [user.id]);
    await reloadUser();
    const s = await settings.saveSettings({ billingEnabled: true, billingPrice: 19.9, billingPlanName: "Planejai Pro" } as any);
    expect(s).toMatchObject({ billingEnabled: true, billingPrice: 19.9, billingTrialDays: 3 });
    expect(s.billingStartedAt).toBeTruthy();
    const a = await billing.billingAccess(user);
    expect(a).toMatchObject({ allowed: true, state: "trial" });
    // o painel não consegue reescrever a data em que a cobrança começou
    expect((await settings.saveSettings({ billingStartedAt: "2000-01-01T00:00:00Z" } as any)).billingStartedAt).toBe(s.billingStartedAt);
  });

  it("acabaram os dias grátis: o assistente avisa uma vez com o link e não chama a IA", async () => {
    await startedDaysAgo(5);
    expect(await billing.billingAccess(user)).toMatchObject({ allowed: false, state: "trial_ended" });

    const channels = await import("../src/channels/index.js");
    const { processConversation } = await import("../src/agent/orchestrator.js");
    const say = async (text: string, id: string) => {
      await db.query("INSERT INTO messages (conversation_id, role, content, external_id) VALUES ($1, 'user', $2, $3)", [convId, text, id]);
      const channel = new channels.PlaygroundChannel();
      const r = await processConversation(convId, { trigger: "message", channel });
      return { channel, r };
    };
    const first = await say("oi, anota um gasto de 10 reais", "b1");
    expect(first.channel.sent).toHaveLength(1);
    expect(first.channel.sent[0]!.text).toMatch(/3 dias grátis acabaram[\s\S]*Planejai Pro[\s\S]*\/assinatura$/);
    const steps = await db.many("SELECT type, name FROM execution_steps WHERE execution_id = $1", [first.r.executionId]);
    expect(steps).toEqual([{ type: "info", name: "trava: assinatura" }]);
    // segunda mensagem no mesmo dia: silêncio, sem repetir o aviso
    expect((await say("oi?", "b2")).channel.sent).toEqual([]);
  });

  it("assinar cria cliente e assinatura mensal no Asaas, sem guardar o CPF, e libera de novo", async () => {
    await expect(billing.subscribe(user, { name: "Carla", cpfCnpj: "529.982.247-25" })).rejects.toThrow(/nome completo/);
    await expect(billing.subscribe(user, { name: "Carla Dias", cpfCnpj: "123.456.789-00" })).rejects.toThrow(/CPF ou CNPJ inválido/);
    expect(asaasCalls).toEqual([]);

    const sub = await billing.subscribe(user, { name: "Carla Dias", cpfCnpj: "529.982.247-25", email: "carla@x.com" });
    const today = new Date().toISOString().slice(0, 10);
    expect(asaasCalls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /customers", "POST /subscriptions", "GET /subscriptions/sub_1/payments"]);
    expect(asaasCalls[0]!.body).toMatchObject({ name: "Carla Dias", cpfCnpj: "52998224725", mobilePhone: "19944440000", externalReference: user.id });
    // forma de pagamento em aberto: Pix, cartão ou boleto na página do Asaas; já passou dos dias grátis, então vence hoje
    expect(asaasCalls[1]!.body).toMatchObject({ customer: "cus_1", billingType: "UNDEFINED", cycle: "MONTHLY", value: 19.9, nextDueDate: today, description: "Planejai Pro" });
    expect(sub).toMatchObject({ status: "trial", asaas_subscription_id: "sub_1", invoice_url: "https://sandbox.asaas.com/i/pay_1" });
    expect(JSON.stringify(await db.one("SELECT * FROM subscriptions"))).not.toContain("52998224725");
    // cobrança criada e ainda dentro da folga do vencimento: volta a responder enquanto o pagamento compensa
    expect(await billing.billingAccess(user)).toMatchObject({ allowed: true, state: "trial" });
    await expect(billing.subscribe(user, { name: "Carla Dias", cpfCnpj: "529.982.247-25" })).rejects.toThrow(/já tem uma assinatura/);
  });

  it("webhook do Asaas: só com o token; pagou libera um mês, venceu ou estornou trava, apagou cancela", async () => {
    const { buildServer } = await import("../src/api/server.js");
    const app = await buildServer();
    const send = (body: unknown, token = TOKEN) => app.inject({ method: "POST", url: "/webhooks/asaas", headers: { "asaas-access-token": token }, payload: body as any });
    const status = async () => (await db.one("SELECT status, to_char(paid_until, 'YYYY-MM-DD') AS paid_until, invoice_url FROM subscriptions"));

    expect((await send({ event: "PAYMENT_RECEIVED", payment: { subscription: "sub_1", dueDate: "2026-10-10" } }, "errado")).statusCode).toBe(401);
    expect((await send({ event: "PAYMENT_RECEIVED", payment: { subscription: "sub_1", dueDate: "2026-10-10" } }, "")).statusCode).toBe(401);
    expect((await status()).status).toBe("trial");
    // evento de assinatura que não é nossa: aceito e ignorado
    expect((await send({ event: "PAYMENT_RECEIVED", payment: { subscription: "sub_de_outro_sistema" } })).json()).toEqual({ ok: true, handled: false });

    const due = new Date().toISOString().slice(0, 10);
    const next = new Date(`${due}T12:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    expect((await send({ event: "PAYMENT_RECEIVED", payment: { subscription: "sub_1", dueDate: due } })).json()).toEqual({ ok: true, handled: true, status: "active" });
    expect(await status()).toEqual({ status: "active", paid_until: next.toISOString().slice(0, 10), invoice_url: null });
    expect(await billing.billingAccess(user)).toMatchObject({ allowed: true, state: "active" });

    // cobrança do mês seguinte criada: guarda o link; venceu: fica pendente, mas o mês pago ainda vale
    await send({ event: "PAYMENT_CREATED", payment: { subscription: "sub_1", status: "PENDING", invoiceUrl: "https://sandbox.asaas.com/i/pay_2", dueDate: next.toISOString().slice(0, 10) } });
    expect((await status()).invoice_url).toBe("https://sandbox.asaas.com/i/pay_2");
    await send({ event: "PAYMENT_OVERDUE", payment: { subscription: "sub_1", invoiceUrl: "https://sandbox.asaas.com/i/pay_2" } });
    expect((await status()).status).toBe("overdue");
    expect(await billing.billingAccess(user)).toMatchObject({ allowed: true, state: "paid_until" });
    // estorno: o mês deixa de valer e trava com o link da cobrança
    await send({ event: "PAYMENT_REFUNDED", payment: { subscription: "sub_1" } });
    const blocked = await billing.billingAccess(user);
    expect(blocked).toMatchObject({ allowed: false, state: "overdue", invoiceUrl: "https://sandbox.asaas.com/i/pay_2" });
    expect(billing.blockedMessage(blocked as any, billing.planOf(await settings.getSettings()))).toContain("https://sandbox.asaas.com/i/pay_2");

    // liberado pelo dono: não importa a assinatura
    await db.query("UPDATE users SET billing_exempt = true WHERE id = $1", [user.id]);
    expect(await billing.billingAccess(await reloadUser())).toEqual({ allowed: true, state: "exempt" });
    await db.query("UPDATE users SET billing_exempt = false WHERE id = $1", [user.id]);
    await reloadUser();

    await billing.cancelSubscription(user.id);
    expect(asaasCalls.at(-1)).toMatchObject({ method: "DELETE", path: "/subscriptions/sub_1" });
    expect((await status()).status).toBe("canceled");
    await app.close();
  });

  it("regras financeiras: avisa no WhatsApp, ignora evento repetido, dá desconto a quem indicou e lembra o vencimento", async () => {
    const outbox = async () => (await db.many("SELECT data FROM pgboss.job WHERE name = 'outbound.send' ORDER BY created_on")).map((r) => r.data);
    await db.query("DELETE FROM pgboss.job WHERE name = 'outbound.send'");
    // Ana já assina (cartão) e convidou o Beto, que paga a primeira mensalidade
    const { upsertUser } = await import("../src/ingest.js");
    const ana = await upsertUser("5519955550000", "Ana");
    const beto = await upsertUser("5519966660000", "Beto");
    await db.query("UPDATE users SET status = 'active', full_name = name WHERE id = ANY($1)", [[ana.id, beto.id]]);
    await db.query("UPDATE users SET invited_by = $1 WHERE id = $2", [ana.id, beto.id]);
    await db.query("INSERT INTO subscriptions (user_id, asaas_customer_id, asaas_subscription_id, status, value, next_due_date, last_payment_at) VALUES ($1, 'cus_a', 'sub_ana', 'active', 19.9, '2026-12-01', now()), ($2, 'cus_b', 'sub_beto', 'trial', 19.9, CURRENT_DATE, NULL)", [ana.id, beto.id]);
    const today = new Date().toISOString().slice(0, 10);

    const evt = { id: "evt_1", event: "PAYMENT_CONFIRMED", payment: { id: "pay_b1", subscription: "sub_beto", value: 19.9, dueDate: today, billingType: "PIX", status: "CONFIRMED" } };
    expect(await billing.handleAsaasEvent(evt)).toMatchObject({ handled: true, status: "active" });
    // o Asaas reenviou o mesmo evento: nada muda e ninguém recebe duas vezes
    expect(await billing.handleAsaasEvent(evt)).toMatchObject({ duplicate: true });
    // cartão/Pix manda RECEIVED do mesmo pagamento depois: não repete a mensagem
    await billing.handleAsaasEvent({ id: "evt_2", event: "PAYMENT_RECEIVED", payment: { ...evt.payment, status: "RECEIVED" } });
    const sent = await outbox();
    expect(sent.filter((m: any) => m.userId === beto.id)).toHaveLength(1);
    expect(sent.find((m: any) => m.userId === beto.id).text).toMatch(/Pagamento de R\$ 19,90 confirmado, obrigado por assinar o Planejai Pro/);
    // indicação: Ana ganha 10% na próxima cobrança em aberto, uma vez só
    expect(sent.find((m: any) => m.userId === ana.id).text).toMatch(/Beto assinou pelo seu convite[\s\S]*10% de desconto/);
    const discount = asaasCalls.find((c) => c.method === "POST" && c.path === "/payments/pay_ana_2");
    expect(discount?.body).toMatchObject({ value: 19.9, dueDate: "2026-12-01", discount: { value: 10, type: "PERCENTAGE", dueDateLimitDays: 0 } });
    expect(await db.one("SELECT applied_payment_id FROM referral_credits WHERE from_user_id = $1", [beto.id])).toEqual({ applied_payment_id: "pay_ana_2" });
    expect(await billing.creditReferral(beto.id)).toBeNull();

    // venceu: avisa com o link na hora
    await billing.handleAsaasEvent({ id: "evt_3", event: "PAYMENT_OVERDUE", payment: { id: "pay_b2", subscription: "sub_beto", value: 19.9, invoiceUrl: "https://sandbox.asaas.com/i/pay_b2" } });
    expect((await outbox()).at(-1)).toMatchObject({ userId: beto.id, text: expect.stringContaining("https://sandbox.asaas.com/i/pay_b2") });
    // o mesmo aviso fica no sininho do painel, caso o WhatsApp esteja fora
    expect(await db.one("SELECT body FROM notifications WHERE user_id = $1 AND kind = 'assinatura' ORDER BY created_at DESC LIMIT 1", [beto.id])).toMatchObject({
      body: expect.stringContaining("pay_b2"),
    });
    // pedido de estorno só avisa o dono; cobrança apagada tira o link que não serve mais
    expect(await billing.handleAsaasEvent({ id: "evt_rr", event: "PAYMENT_REFUND_REQUESTED", payment: { id: "pay_b2", subscription: "sub_beto", value: 19.9 } })).toMatchObject({ handled: true, status: "overdue" });
    expect(await billing.handleAsaasEvent({ id: "evt_del", event: "PAYMENT_DELETED", payment: { id: "pay_b2", subscription: "sub_beto", value: 19.9, invoiceUrl: "https://sandbox.asaas.com/i/pay_b2" } })).toMatchObject({ handled: true });
    expect(await db.one("SELECT invoice_url FROM subscriptions WHERE user_id = $1", [beto.id])).toEqual({ invoice_url: null });

    // lembrete de vencimento: quem paga por Pix ouve 3 dias antes; cartão não
    await db.query("DELETE FROM pgboss.job WHERE name = 'outbound.send'");
    await db.query("UPDATE subscriptions SET status = 'active', next_due_date = CURRENT_DATE + 3, last_billing_type = 'PIX', reminded_on = NULL WHERE user_id = $1", [beto.id]);
    await db.query("UPDATE subscriptions SET next_due_date = CURRENT_DATE + 3, last_billing_type = 'CREDIT_CARD' WHERE user_id = $1", [ana.id]);
    expect((await billing.billingReminders()).due).toBe(1);
    expect((await outbox())[0]).toMatchObject({ userId: beto.id, text: expect.stringMatching(/vence a sua mensalidade de R\$ 19,90/) });
    // mesmo dia: não repete
    expect((await billing.billingReminders()).due).toBe(0);
  });
});
