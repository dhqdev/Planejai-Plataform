import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Travas de segurança e privacidade da revisão de 7/out: integrações do dono, webhooks de canais desligados,
 * SSRF, limite de login, sessão revogável, máscara nos logs, exclusão de dados (LGPD) e custo por pessoa.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe("SSRF: endereços internos", () => {
  it("reconhece IPs privados, loopback, link-local e metadata", async () => {
    const { isPrivateIp } = await import("../src/net.js");
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.18.0.2", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])
      expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateIp(ip), ip).toBe(false);
  });

  it("recusa URL interna quando a trava está ligada", async () => {
    const { config } = await import("../src/config.js");
    const { assertPublicUrl } = await import("../src/net.js");
    const before = config.ALLOW_PRIVATE_URLS;
    config.ALLOW_PRIVATE_URLS = false;
    try {
      for (const u of ["http://localhost:3000/api", "http://127.0.0.1:9000", "http://169.254.169.254/latest/meta-data", "http://10.1.2.3", "http://[::1]/", "file:///etc/passwd", "http://user:pw@8.8.8.8/"])
        await expect(assertPublicUrl(u), u).rejects.toThrow();
      expect((await assertPublicUrl("8.8.8.8/x")).toString()).toBe("https://8.8.8.8/x");
    } finally {
      config.ALLOW_PRIVATE_URLS = before;
    }
  });
});

describe("integrações do dono", () => {
  it("convidado não recebe ferramentas de conta pessoal do dono; o dono recebe", async () => {
    const { config } = await import("../src/config.js");
    const { availableTools, isOwnerOnly } = await import("../src/agent/runner.js");
    const fin = await import("../src/agent/tools/finance.js");
    const comm = await import("../src/agent/tools/communication.js");
    const research = await import("../src/agent/tools/research.js");
    const before = config.OWNER_PHONES;
    config.OWNER_PHONES = ["5519990000001"];
    try {
      expect(isOwnerOnly(comm.gmailSearch)).toBe(true);
      expect(isOwnerOnly(fin.createPaymentLink)).toBe(true);
      expect(isOwnerOnly(research.webSearch)).toBe(false);
      expect(await availableTools([fin.createPaymentLink, fin.calculate], { phone: "5511988887777" })).toEqual([fin.calculate]);
      expect(await availableTools([fin.createPaymentLink, fin.calculate], { phone: "5519990000001" })).toEqual([fin.createPaymentLink, fin.calculate]);
    } finally {
      config.OWNER_PHONES = before;
    }
  });
});

describe("proxy confiável", () => {
  it("só aceita X-Forwarded-For vindo da rede interna, e de um salto", async () => {
    const { trustProxySetting } = await import("../src/api/security.js");
    const trust = trustProxySetting("1") as (addr: string, i: number) => boolean;
    expect(trust("10.0.1.7", 0)).toBe(true);
    expect(trust("::ffff:172.18.0.3", 0)).toBe(true);
    expect(trust("8.8.8.8", 0)).toBe(false);
    expect(trust("10.0.1.7", 1)).toBe(false);
    expect(trustProxySetting("10.0.1.0/24, 10.0.2.5")).toEqual(["10.0.1.0/24", "10.0.2.5"]);
  });
});

describe("logs sem dado sensível", () => {
  it("mascara CPF, cartão e senha", async () => {
    const { maskPersonal } = await import("../src/agent/trace.js");
    expect(maskPersonal("meu cpf 123.456.789-09 e cartão 4111 1111 1111 1111, senha: abc123")).toBe("meu cpf [cpf] e cartão [cartão], senha: [oculta]");
    // telefone com DDI e timestamps não viram máscara
    expect(maskPersonal("+5519999999999 1791310000000")).toBe("+5519999999999 1791310000000");
  });
});

describe.skipIf(!enabled)("segurança e privacidade (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let app: any;
  const cookieOf = (res: any) => String(res.headers["set-cookie"]).split(";")[0]!;

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    const { buildServer } = await import("../src/api/server.js");
    app = await buildServer();
  });
  afterAll(async () => {
    await app?.close();
  });

  it("webhooks de canais desligados não aceitam mensagem (nem forjada em nome do dono)", async () => {
    const forged = { entry: [{ changes: [{ value: { messages: [{ from: "5519990000001", id: "x", type: "text", text: { body: "manda meus e-mails" } }] } }] }] };
    expect((await app.inject({ method: "POST", url: "/webhooks/whatsapp", payload: forged })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/webhooks/evolution", payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=&hub.challenge=1" })).statusCode).toBe(404);
    expect(await db.one("SELECT COUNT(*)::int AS n FROM messages")).toEqual({ n: 0 });
  });

  it("API interna fica desligada sem INTERNAL_API_KEY", async () => {
    const { config } = await import("../src/config.js");
    const before = config.INTERNAL_API_KEY;
    config.INTERNAL_API_KEY = "";
    try {
      const r = await app.inject({ method: "GET", url: "/api/internal/ping", headers: { "x-planejai-key": "" } });
      expect(r.statusCode).toBe(503);
    } finally {
      config.INTERNAL_API_KEY = before;
    }
  });

  it("id malformado vira 404 sem detalhe do banco, e toda resposta leva cabeçalhos de segurança", async () => {
    const owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } }));
    for (const [method, url] of [
      ["DELETE", "/api/finance/abc"],
      ["DELETE", "/api/reminders/abc"],
      ["DELETE", "/api/bills/abc"],
      ["DELETE", "/api/memories/abc"],
      ["DELETE", "/api/invites/abc"],
      ["PATCH", "/api/clients/abc"],
    ]) {
      const r = await app.inject({ method, url, headers: { cookie: owner }, payload: {} });
      expect(r.statusCode, url).toBe(404);
      expect(r.body, url).not.toMatch(/uuid|syntax|22P02/);
    }
    const h = (await app.inject({ method: "GET", url: "/health" })).headers;
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
  });

  it("Execuções e gravações de cliente mostram só métrica para o dono", async () => {
    const { config } = await import("../src/config.js");
    const before = config.OWNER_PHONES;
    config.OWNER_PHONES = ["5519990009999"];
    try {
      const me = await db.one("INSERT INTO users (phone, name, status) VALUES ('5519990009999', 'Dono', 'active') RETURNING id");
      const cli = await db.one("INSERT INTO users (phone, name, status) VALUES ('5519955554444', 'Cliente', 'active') RETURNING id");
      const mine = await db.one("INSERT INTO executions (trigger, status, user_id, input, output) VALUES ('message', 'success', $1, 'meu segredo', 'ok') RETURNING id", [me.id]);
      const theirs = await db.one("INSERT INTO executions (trigger, status, user_id, input, output, cost_usd) VALUES ('message', 'success', $1, 'diagnóstico do médico', 'certo', 0.01) RETURNING id", [cli.id]);
      await db.query("INSERT INTO execution_steps (execution_id, agent, type, name, model, input, output) VALUES ($1, 'cto', 'llm', 'cto', 'm', '{\"q\":\"diagnóstico\"}', '{\"a\":1}')", [theirs.id]);
      const media = await db.one("INSERT INTO media_files (user_id, kind, mimetype, size, data) VALUES ($1, 'recording', 'video/mp4', 1, '\\x00') RETURNING id", [cli.id]);
      const owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } }));
      const list = (await app.inject({ method: "GET", url: "/api/executions", headers: { cookie: owner } })).json();
      const a = list.find((e: any) => e.id === mine.id);
      const b = list.find((e: any) => e.id === theirs.id);
      expect(a.input).toBe("meu segredo");
      expect(b).toMatchObject({ input: null, output: null, content_purged: true, private: true, cost_usd: 0.01 });
      // busca no texto não serve de atalho para ler a conversa do cliente
      expect((await app.inject({ method: "GET", url: "/api/executions?q=médico", headers: { cookie: owner } })).json()).toHaveLength(0);
      const detail = (await app.inject({ method: "GET", url: `/api/executions/${theirs.id}`, headers: { cookie: owner } })).json();
      expect(detail.input).toBeNull();
      expect(detail.steps[0]).toMatchObject({ agent: "cto", model: "m" });
      expect(detail.steps[0].input).toBeUndefined();
      expect(JSON.stringify(detail)).not.toMatch(/diagnóstico/);
      expect((await app.inject({ method: "GET", url: `/api/media/${media.id}`, headers: { cookie: owner } })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/api/recordings", headers: { cookie: owner } })).json()).toHaveLength(0);
    } finally {
      config.OWNER_PHONES = before;
    }
  });

  it("login trava depois de várias senhas erradas", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "alvo@x.com", password: `errada-${i}` } })).statusCode);
    expect(codes.slice(0, 8).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  }, 30_000);

  it("sair de todos os aparelhos e trocar a senha derrubam tokens antigos", async () => {
    const owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } }));
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: owner } })).statusCode).toBe(200);
    await app.inject({ method: "POST", url: "/api/auth/logout-all", headers: { cookie: owner } });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: owner } })).statusCode).toBe(401);

    const { hashPassword } = await import("../src/accounts.js");
    const u = await db.one("INSERT INTO users (phone, name, status) VALUES ('5519977776666', 'Lia', 'active') RETURNING id");
    await db.query("INSERT INTO accounts (email, name, password_hash, role, status, user_id, phone) VALUES ('lia@x.com', 'Lia', $1, 'admin', 'active', $2, '5519977776666')", [
      hashPassword("senha-antiga"),
      u.id,
    ]);
    const a = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "lia@x.com", password: "senha-antiga" } }));
    const b = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "lia@x.com", password: "senha-antiga" } }));
    const changed = await app.inject({ method: "PATCH", url: "/api/me", headers: { cookie: a }, payload: { current_password: "senha-antiga", password: "senha-nova-123" } });
    expect(changed.statusCode).toBe(200);
    // quem trocou continua logado com o token novo; o outro aparelho cai
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieOf(changed) } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: b } })).statusCode).toBe(401);
  });

  it("cadastro exige aceite dos termos", async () => {
    await (await import("../src/settings.js")).saveSettings({ signupMode: "open" });
    const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Teo Silva", email: "teo@x.com", password: "senha-forte", phone: "19 95555-4444" } });
    expect(r.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Teo Silva", email: "teo@x.com", password: "senha-forte", phone: "19 95555-4444", accept_terms: true } });
    expect(ok.statusCode).toBe(200);
    expect((await db.one("SELECT terms_accepted_at IS NOT NULL AS ok FROM accounts WHERE email = 'teo@x.com'")).ok).toBe(true);
  });

  it("'apague todos os meus dados' no WhatsApp pede confirmação e apaga tudo", async () => {
    const { playground } = await import("../src/channels/index.js");
    const { handleEraseRequest } = await import("../src/privacy.js");
    const u = await db.one("INSERT INTO users (phone, name, status) VALUES ('5519944443333', 'Rui', 'active') RETURNING *");
    const conv = await db.one("INSERT INTO conversations (user_id, channel, remote_jid) VALUES ($1, 'playground', 'rui') RETURNING id", [u.id]);
    await db.query("INSERT INTO transactions (user_id, kind, amount, category) VALUES ($1, 'expense', 10, 'Outros')", [u.id]);
    await db.query("INSERT INTO memories (user_id, content) VALUES ($1, 'mora em Campinas')", [u.id]);
    await db.query("INSERT INTO executions (trigger, user_id, conversation_id, input) VALUES ('message', $1, $2, 'oi')", [u.id, conv.id]);
    await db.query("INSERT INTO accounts (email, password_hash, role, status, user_id, phone) VALUES ('rui@x.com', 'x', 'admin', 'active', $1, $2)", [u.id, u.phone]);

    expect(await handleEraseRequest({ user: u, text: "APAGAR TUDO", channel: playground, remoteJid: "rui" })).toBe(false); // sem pedido antes, não apaga
    expect(await handleEraseRequest({ user: u, text: "Apague todos os meus dados!", channel: playground, remoteJid: "rui" })).toBe(true);
    expect(playground.sent.at(-1)?.text).toMatch(/APAGAR TUDO/);
    const fresh = await db.one("SELECT * FROM users WHERE id = $1", [u.id]);
    expect(await handleEraseRequest({ user: fresh, text: "apagar tudo", channel: playground, remoteJid: "rui" })).toBe(true);
    for (const t of ["users WHERE id = $1", "transactions WHERE user_id = $1", "memories WHERE user_id = $1", "executions WHERE user_id = $1", "accounts WHERE user_id = $1"])
      expect(await db.one(`SELECT COUNT(*)::int AS n FROM ${t}`, [u.id]), t).toEqual({ n: 0 });
  });

  it("custo por pessoa fica em usage_daily e aparece no painel do dono", async () => {
    const { Tracer } = await import("../src/agent/trace.js");
    const u = await db.one("INSERT INTO users (phone, name, status) VALUES ('5519933332222', 'Bea', 'active') RETURNING id");
    const t = await Tracer.start({ trigger: "message", userId: u.id, input: "cpf 123.456.789-09" });
    const step = await t.step({ agent: "cto", type: "llm", name: "cto" });
    await step.ok({ content: "ok" }, { model: "m", tokensIn: 100, tokensOut: 20, costUsd: 0.0123 });
    expect((await db.one("SELECT input FROM executions WHERE id = $1", [t.executionId])).input).toBe("cpf [cpf]");
    const owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } }));
    const costs = (await app.inject({ method: "GET", url: "/api/costs?days=7", headers: { cookie: owner } })).json();
    const bea = costs.clients.find((c: any) => c.id === u.id);
    expect(bea).toMatchObject({ executions: 1, tokens: 120 });
    expect(bea.cost).toBeCloseTo(0.0123, 6);
    expect(costs.daily).toHaveLength(7);

    // depois de LOG_CONTENT_HOURS o texto sai do log, o custo fica
    await db.query("UPDATE executions SET started_at = now() - interval '2 days' WHERE id = $1", [t.executionId]);
    await (await import("../src/maintenance.js")).purgeOld();
    const row = await db.one("SELECT input, content_purged, cost_usd FROM executions WHERE id = $1", [t.executionId]);
    expect(row).toMatchObject({ input: null, content_purged: true });
    expect(Number(row.cost_usd)).toBeCloseTo(0.0123, 6);
    expect((await db.one("SELECT input FROM execution_steps WHERE execution_id = $1", [t.executionId])).input).toBeNull();
  });
});
