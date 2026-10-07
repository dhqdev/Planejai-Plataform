import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Telegram (ligar conta por link e por contato) e API interna para o n8n (chave, contas, envio, gastos, eventos),
 * com Postgres real; a API do Telegram e o n8n são falsos.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe("Telegram: formatação", () => {
  it("converte o estilo do WhatsApp para HTML do Telegram, escapando o resto", async () => {
    const { toTelegramHtml } = await import("../src/channels/telegram.js");
    expect(toTelegramHtml("*Total:* R$ 5 <b> & _ok_")).toBe("<b>Total:</b> R$ 5 &lt;b&gt; &amp; <i>ok</i>");
  });
});

describe.skipIf(!enabled)("Telegram e API interna (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let app: any;
  let key: string;
  let user: any;
  const tgCalls: { method: string; body: any }[] = [];
  const events: any[] = [];
  let n8n: http.Server;

  beforeAll(async () => {
    n8n = http
      .createServer((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
          events.push({ sig: req.headers["x-planejai-signature"], ...JSON.parse(b) });
          res.end("{}");
        });
      })
      .listen(4611);
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
      const url = String(input);
      if (url.startsWith("https://api.telegram.org/")) {
        const method = url.split("/").pop()!;
        tgCalls.push({ method, body: init?.body && typeof init.body === "string" ? JSON.parse(init.body) : init?.body });
        const result = method === "getMe" ? { username: "planejai_bot" } : { message_id: tgCalls.length };
        return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
      }
      return realFetch(input, init);
    });
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    const { buildServer } = await import("../src/api/server.js");
    app = await buildServer();
    key = (await import("../src/events.js")).internalKey();
    const { saveCredentials } = await import("../src/integrations/registry.js");
    await saveCredentials("telegram", { bot_token: "123:abc", username: "planejai_bot" });
    await saveCredentials("n8n", { base_url: "http://127.0.0.1:4611", api_key: "x", events_url: "http://127.0.0.1:4611/webhook/eventos" });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    n8n?.close();
    await app?.close();
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  const H = () => ({ "x-planejai-key": key });

  it("API interna exige a chave e cria pessoa com login do painel", async () => {
    expect((await app.inject({ method: "GET", url: "/api/internal/ping" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/internal/ping", headers: { "x-planejai-key": "errada" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/internal/ping", headers: H() })).json().ok).toBe(true);

    const r = await app.inject({ method: "POST", url: "/api/internal/users", headers: H(), payload: { name: "Bia Souza", phone: "(19) 98888-7777", email: "bia@x.com", password: "senha-forte" } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ ok: true, created: true, user: { phone: "5519988887777", status: "active" } });
    expect(body.account_id).toBeTruthy();
    user = body.user;
    // o login funciona com a senha criada pela automação
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "bia@x.com", password: "senha-forte" } });
    expect(login.statusCode).toBe(200);
    // troca de senha pela automação (recuperar senha)
    expect((await app.inject({ method: "PATCH", url: "/api/internal/users", headers: H(), payload: { email: "bia@x.com", password: "nova-senha-123" } })).json().ok).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "bia@x.com", password: "nova-senha-123" } })).statusCode).toBe(200);
    // busca pelo número sem o 9
    const found = await app.inject({ method: "GET", url: "/api/internal/users?phone=551988887777", headers: H() });
    expect(found.json()).toMatchObject({ exists: true, user: { id: user.id } });
    await new Promise((r) => setTimeout(r, 200));
    expect(events.find((e) => e.event === "user.created")?.data.user_id).toBe(user.id);
  });

  it("lança gasto pela automação e avisa o n8n", async () => {
    const r = await app.inject({ method: "POST", url: "/api/internal/transactions", headers: H(), payload: { phone: "5519988887777", amount: "32,50", description: "uber", external_ref: "ext-1" } });
    expect(r.json()).toMatchObject({ ok: true, transaction: { category: "Transporte", source: "automacao" } });
    const again = await app.inject({ method: "POST", url: "/api/internal/transactions", headers: H(), payload: { phone: "5519988887777", amount: "32,50", description: "uber", external_ref: "ext-1" } });
    expect(again.json().duplicate).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    const ev = events.find((e) => e.event === "transaction.created");
    expect(ev.data.amount).toBe(32.5);
    const { createHmac } = await import("node:crypto");
    expect(ev.sig).toBe(createHmac("sha256", key).update(JSON.stringify({ event: ev.event, at: ev.at, data: ev.data })).digest("hex"));
  });

  it("liga o Telegram pelo link do painel e passa a conversar por lá", async () => {
    const { telegramLink, handleTelegramUpdate } = await import("../src/telegram.js");
    const link = await telegramLink(user.id);
    expect(link.url).toMatch(/^https:\/\/t\.me\/planejai_bot\?start=/);
    const code = link.url.split("start=")[1];
    const msg = (text: string, extra: any = {}) => ({ update_id: 1, message: { message_id: Math.floor(Math.random() * 1e6), chat: { id: 777, type: "private" }, from: { id: 777, first_name: "Bia", username: "biasouza" }, date: Math.floor(Date.now() / 1000), text, ...extra } });

    await handleTelegramUpdate(msg(`/start ${code}`));
    expect(await db.one("SELECT user_id, username FROM channel_links WHERE channel = 'telegram' AND external_id = '777'")).toEqual({ user_id: user.id, username: "biasouza" });
    expect(tgCalls.at(-1)!.body.text).toContain("Pronto, Bia!");
    // o código é de uso único
    await handleTelegramUpdate(msg(`/start ${code}`, { chat: { id: 888, type: "private" }, from: { id: 888, first_name: "Outro" } }));
    expect(tgCalls.at(-1)!.body.text).toContain("expirou");

    // mensagem normal entra na fila do assistente, na conversa do Telegram
    await handleTelegramUpdate(msg("gastei 20 no almoço"));
    const conv = await db.one("SELECT id FROM conversations WHERE user_id = $1 AND channel = 'telegram' AND remote_jid = '777'", [user.id]);
    expect(conv).toBeTruthy();
    expect((await db.many("SELECT content FROM messages WHERE conversation_id = $1", [conv.id])).map((m: any) => m.content)).toContain("gastei 20 no almoço");

    // a API interna manda no canal onde a pessoa está conversando (agora o Telegram)
    const { runOutboundJob } = await import("../src/api/routes/internal.js");
    tgCalls.length = 0;
    await runOutboundJob({ type: "send", userId: user.id, phone: user.phone, channel: "auto", text: "*Pagamento aprovado*" });
    expect(tgCalls[0]).toMatchObject({ method: "sendMessage", body: { chat_id: "777", text: "<b>Pagamento aprovado</b>", parse_mode: "HTML" } });
  });

  it("quem não está ligado só recebe como conectar; contato de número sem convite não entra", async () => {
    const { handleTelegramUpdate } = await import("../src/telegram.js");
    tgCalls.length = 0;
    const base = { chat: { id: 999, type: "private" }, from: { id: 999, first_name: "Zé" }, date: Math.floor(Date.now() / 1000) };
    await handleTelegramUpdate({ message: { ...base, message_id: 1, text: "oi" } });
    expect(tgCalls[0].body.reply_markup.keyboard[0][0].request_contact).toBe(true);
    await handleTelegramUpdate({ message: { ...base, message_id: 2, contact: { phone_number: "+55 19 97777-0000", user_id: 999 } } });
    expect(tgCalls.at(-1)!.body.text).toContain("convite");
    expect(await db.many("SELECT 1 FROM channel_links WHERE external_id = '999'")).toEqual([]);
    // contato de outra pessoa não vale
    await handleTelegramUpdate({ message: { ...base, message_id: 3, contact: { phone_number: "5519988887777", user_id: 123 } } });
    expect(tgCalls.at(-1)!.body.text).toContain("seu próprio número");
    // o próprio número cadastrado liga a conta
    await handleTelegramUpdate({ message: { ...base, chat: { id: 1001, type: "private" }, from: { id: 1001, first_name: "Bia" }, message_id: 4, contact: { phone_number: "5519988887777", user_id: 1001 } } });
    expect((await db.one("SELECT user_id FROM channel_links WHERE external_id = '1001'")).user_id).toBe(user.id);
    // uma conta do Telegram por pessoa: a ligação anterior saiu
    expect(await db.many("SELECT 1 FROM channel_links WHERE external_id = '777'")).toEqual([]);
  });
});
