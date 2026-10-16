import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Chat do app (aba Início no celular): mesma conversa do motor do WhatsApp, guardada em app_chat para a tela.
 * Cada pessoa só vê a própria conversa e os próprios arquivos; lembrete que nasce no app sai pelo WhatsApp.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);

let server: http.Server;
const completion = (content: string) => ({
  model: "fake/model",
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.000001 },
});
function fakeOpenRouter(body: any) {
  const userText = String(body.messages.findLast((m: any) => m.role === "user")?.content ?? "");
  if (userText.includes("Lembrete agendado disparou")) return completion("Ei, hora de beber água 💧");
  if (userText.includes("oi time")) return completion("Oi, Ana! Tudo certo por aqui 😊");
  return completion("ok");
}

describe.skipIf(!enabled)("chat do app (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let app: any;
  let ana: any;
  let bia: any;
  const cookies: Record<string, string> = {};
  const cookieOf = (res: any) => ([] as string[]).concat(res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]!).find((c) => c.startsWith("pj_session="))!;

  beforeAll(async () => {
    server = http
      .createServer((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(fakeOpenRouter(JSON.parse(b))));
        });
      })
      .listen(4599);
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    const { upsertUser } = await import("../src/ingest.js");
    ana = await upsertUser("5519933330001", "Ana");
    bia = await upsertUser("5519933330002", "Bia");
    const { hashPassword } = await import("../src/accounts.js");
    for (const [email, u] of [["ana@x.com", ana], ["bia@x.com", bia]] as const) {
      await db.query("UPDATE users SET status = 'active' WHERE id = $1", [u.id]);
      await db.query("INSERT INTO accounts (email, name, password_hash, role, status, user_id, phone) VALUES ($1, $2, $3, 'admin', 'active', $4, $5)", [email, u.name, hashPassword("senha-forte-1"), u.id, u.phone]);
    }
    const { buildServer } = await import("../src/api/server.js");
    app = await buildServer();
    for (const email of ["ana@x.com", "bia@x.com"]) {
      const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "senha-forte-1" } });
      cookies[email] = cookieOf(r);
    }
  });

  afterAll(async () => {
    server?.close();
    await app?.close();
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  const as = (email: string, method: string, url: string, payload?: unknown) => app.inject({ method, url, payload, headers: { cookie: cookies[email] } });

  it("mensagem do app passa pelo mesmo motor e a resposta aparece no chat", async () => {
    const first = (await as("ana@x.com", "GET", "/api/chat")).json();
    expect(first.ready).toBe(true);
    expect(first.messages).toEqual([]);
    expect(first.hello.name).toBe("Ana");

    const sent = (await as("ana@x.com", "POST", "/api/chat", { text: "oi time" })).json();
    expect(sent.queued).toBe(true);
    expect(sent.message).toMatchObject({ role: "user", text: "oi time" });
    const conv = await db.one("SELECT * FROM conversations WHERE user_id = $1 AND channel = 'app'", [ana.id]);
    expect(conv.remote_jid).toBe(`app:${ana.id}`);
    expect((await as("ana@x.com", "GET", `/api/chat?after=${sent.message.id}`)).json().working).toBe(true);

    const { processConversation } = await import("../src/agent/orchestrator.js");
    await processConversation(conv.id, { trigger: "message" });
    const after = (await as("ana@x.com", "GET", `/api/chat?after=${sent.message.id}`)).json();
    expect(after.working).toBe(false);
    expect(after.messages.map((m: any) => m.text).join(" ")).toContain("Oi, Ana! Tudo certo por aqui");
    expect(after.messages.every((m: any) => m.role === "assistant")).toBe(true);

    // a Bia não vê a conversa da Ana
    expect((await as("bia@x.com", "GET", "/api/chat")).json().messages).toEqual([]);
  });

  it("o time conversando entre si aparece no chat do app, e só nele", async () => {
    const { noteTeamTalk } = await import("../src/channels/app.js");
    const conv = await db.one("SELECT * FROM conversations WHERE user_id = $1 AND channel = 'app'", [ana.id]);
    const last = (await as("ana@x.com", "GET", "/api/chat")).json().messages.at(-1).id;
    await noteTeamTalk({ conversation: conv }, "cto", "agenda", "[contexto] *Liste* os compromissos de amanhã da Ana. Fuso America/Sao_Paulo e mais detalhes.", "ask");
    await noteTeamTalk({ conversation: { ...conv, channel: "whatsapp" } }, "cto", "agenda", "não aparece", "ask");
    const after = (await as("ana@x.com", "GET", `/api/chat?after=${last}`)).json().messages;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ role: "team", text: "Liste os compromissos de amanhã da Ana.", media: { from: "cto", to: "agenda", kind: "ask" } });
  });

  it("foto mandada pelo app só abre para quem mandou", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64").toString("base64");
    const sent = (await as("ana@x.com", "POST", "/api/chat", { media: { base64: png, mimetype: "image/png", fileName: "a.png" } })).json();
    expect(sent.message.media).toMatchObject({ kind: "image", url: `/api/chat/media/${sent.message.id}` });
    const mine = await as("ana@x.com", "GET", sent.message.media.url);
    expect(mine.statusCode).toBe(200);
    expect(mine.headers["content-type"]).toBe("image/png");
    expect((await as("bia@x.com", "GET", sent.message.media.url)).statusCode).toBe(404);
  });

  it("lembrete criado no app chega pelo WhatsApp, não no chat do app", async () => {
    const { upsertConversation } = await import("../src/ingest.js");
    const wa = await upsertConversation(ana.id, "playground", "jid-ana");
    const { conversationOf } = await import("../src/social.js");
    // o app é a conversa mais recente, mas aviso sai pelo WhatsApp
    await db.query("UPDATE conversations SET updated_at = now() + interval '1 minute' WHERE user_id = $1 AND channel = 'app'", [ana.id]);
    expect((await conversationOf(ana.id, ana.phone)).conv.id).toBe(wa.id);

    const appConv = await db.one("SELECT id FROM conversations WHERE user_id = $1 AND channel = 'app'", [ana.id]);
    const before = (await db.one("SELECT COUNT(*)::int AS n FROM app_chat WHERE user_id = $1", [ana.id])).n;
    const { channels } = await import("../src/channels/index.js");
    const playground = channels.playground as any;
    const sentBefore = playground.sent.length;
    const { processConversation } = await import("../src/agent/orchestrator.js");
    await processConversation(appConv.id, { trigger: "reminder", event: "Lembrete agendado disparou agora. O que lembrar: beber água" });
    expect(playground.sent.slice(sentBefore).map((s: any) => s.text).join(" ")).toContain("beber água");
    expect((await db.one("SELECT COUNT(*)::int AS n FROM app_chat WHERE user_id = $1", [ana.id])).n).toBe(before);
  });

  it("conta sem WhatsApp ligado recebe o aviso em vez do chat", async () => {
    const { hashPassword } = await import("../src/accounts.js");
    await db.query("INSERT INTO accounts (email, name, password_hash, role, status) VALUES ('solto@x.com', 'Solto', $1, 'admin', 'active')", [hashPassword("senha-forte-1")]);
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "solto@x.com", password: "senha-forte-1" } });
    const res = await app.inject({ method: "GET", url: "/api/chat", headers: { cookie: cookieOf(r) } });
    expect(res.json()).toMatchObject({ ready: false });
    const post = await app.inject({ method: "POST", url: "/api/chat", headers: { cookie: cookieOf(r) }, payload: { text: "oi" } });
    expect(post.statusCode).toBe(400);
  });
});
