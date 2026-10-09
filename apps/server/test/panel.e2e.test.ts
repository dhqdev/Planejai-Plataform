import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Painel novo ponta a ponta (Postgres real): notificações com bolinha, documentos guardados,
 * código no WhatsApp ao entrar de navegador novo e link do Google Maps.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
// este arquivo liga o código de login (os outros testes rodam com LOGIN_CODE=false)
process.env.LOGIN_CODE = "true";
process.env.WHATSAPP_PROVIDER = "evolution";

describe("link do Google Maps", () => {
  it("rota de ônibus vira modo transit; sem origem mostra só o lugar", async () => {
    const { mapsUrl } = await import("../src/agent/tools/research.js");
    const u = new URL(mapsUrl("Unicamp", "Rodoviária de Campinas", "onibus"));
    expect(u.pathname).toBe("/maps/dir/");
    expect(u.searchParams.get("travelmode")).toBe("transit");
    expect(u.searchParams.get("origin")).toBe("Rodoviária de Campinas");
    expect(new URL(mapsUrl("Unicamp")).searchParams.get("query")).toBe("Unicamp");
  });
});

describe.skipIf(!enabled)("painel: notificações, documentos e login (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let app: any;
  let ana: any;
  let bia: any;
  const cookieOf = (res: any, name = "pj_session") =>
    ([] as string[]).concat(res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]!).find((c) => c.startsWith(`${name}=`))!;

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    const { upsertUser } = await import("../src/ingest.js");
    ana = await upsertUser("5519911110001", "Ana");
    bia = await upsertUser("5519911110002", "Bia");
    const { hashPassword } = await import("../src/accounts.js");
    for (const [email, u] of [["ana@x.com", ana], ["bia@x.com", bia]] as const)
      await db.query("INSERT INTO accounts (email, name, password_hash, role, status, user_id, phone) VALUES ($1, $2, $3, 'admin', 'active', $4, $5)", [email, u.name, hashPassword("senha-forte-1"), u.id, u.phone]);
    const { buildServer } = await import("../src/api/server.js");
    app = await buildServer();
  });
  afterAll(async () => {
    await app?.close();
  });

  /** Entra passando pelo código: o código sai do envio (que na vida real vai pelo WhatsApp). */
  async function loginWithCode(email: string) {
    const { startChallenge, verifyChallenge } = await import("../src/logincode.js");
    const { loadAccount } = await import("../src/accounts.js");
    void verifyChallenge;
    const row = await db.one("SELECT id FROM accounts WHERE email = $1", [email]);
    let code = "";
    const ch: any = await startChallenge((await loadAccount(row.id))!, async (_p, text) => (code = text.match(/\d{6}/)![0]));
    const r = await app.inject({ method: "POST", url: "/api/auth/login/verify", payload: { challenge: ch.challenge, code } });
    expect(r.statusCode).toBe(200);
    return { session: cookieOf(r), device: cookieOf(r, "pj_dev") };
  }

  it("esqueci a senha: código no WhatsApp (plano B sem n8n), senha nova e os outros logins caem", async () => {
    // conta própria deste teste: os outros seguem com a senha de sempre
    const { upsertUser } = await import("../src/ingest.js");
    const { hashPassword } = await import("../src/accounts.js");
    const cris = await upsertUser("5519911110003", "Cris");
    await db.query("INSERT INTO accounts (email, name, password_hash, role, status, user_id, phone) VALUES ('cris@x.com', 'Cris', $1, 'admin', 'active', $2, $3)", [hashPassword("senha-forte-1"), cris.id, cris.phone]);
    const { session: old } = await loginWithCode("cris@x.com");
    // e-mail sem conta responde igual (não revela quem tem cadastro) e não manda nada
    const before = await db.one("SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'outbound.send'");
    const ghost = await app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email: "ninguem@x.com" } });
    expect(ghost.statusCode).toBe(200);
    expect(ghost.json().challenge).toMatch(/^[0-9a-f-]{36}$/);
    expect((await db.one("SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'outbound.send'")).n).toBe(before.n);

    const r = await app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email: "cris@x.com" } });
    expect(r.statusCode).toBe(200);
    // sem n8n configurado, o código vai pela nossa fila para o WhatsApp da conta
    const job = await db.one("SELECT data FROM pgboss.job WHERE name = 'outbound.send' ORDER BY created_on DESC LIMIT 1");
    expect(job.data).toMatchObject({ type: "send", phone: "5519911110003" });
    const code = job.data.text.match(/\d{6}/)[0];
    // o código de senha não serve para o login de navegador novo
    expect((await app.inject({ method: "POST", url: "/api/auth/login/verify", payload: { challenge: r.json().challenge, code } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/reset", payload: { challenge: r.json().challenge, code, password: "curta" } })).statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/api/auth/reset", payload: { challenge: r.json().challenge, code, password: "senha-nova-22" } });
    expect(ok.statusCode).toBe(200);
    expect(cookieOf(ok)).toBeTruthy();
    // código usado não vale de novo; sessão antiga caiu; senha nova entra
    expect((await app.inject({ method: "POST", url: "/api/auth/reset", payload: { challenge: r.json().challenge, code, password: "outra-senha-33" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/notifications", headers: { cookie: old } })).statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { cookie: cookieOf(ok, "pj_dev") }, payload: { email: "cris@x.com", password: "senha-nova-22" } });
    expect(login.statusCode).toBe(200);
  });

  it("navegador novo recebe código no WhatsApp; errado não entra; depois o navegador fica conhecido", async () => {
    await db.query("UPDATE wa_sessions SET status = 'connected', heartbeat_at = now()").catch(() => {});
    const first = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ana@x.com", password: "senha-forte-1" } });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body).toMatchObject({ needs_code: true });
    expect(body.to).toContain("0001");
    expect(cookieOf(first)).toBeUndefined();
    // o código foi para a fila de saída, para o número da conta
    const job = await db.one("SELECT data FROM pgboss.job WHERE name = 'outbound.send' ORDER BY created_on DESC LIMIT 1");
    expect(job.data).toMatchObject({ type: "send", phone: "5519911110001", channel: "whatsapp" });
    expect(job.data.text).toMatch(/\d{6}/);

    for (let i = 0; i < 5; i++)
      expect((await app.inject({ method: "POST", url: "/api/auth/login/verify", payload: { challenge: body.challenge, code: "000000" } })).statusCode).toBe(401);
    // 5 erros: nem o código certo vale mais
    const real = job.data.text.match(/\d{6}/)[0];
    const locked = await app.inject({ method: "POST", url: "/api/auth/login/verify", payload: { challenge: body.challenge, code: real } });
    expect(locked.statusCode).toBe(401);

    const { session, device } = await loginWithCode("ana@x.com");
    expect(session).toBeTruthy();
    expect(device).toBeTruthy();
    const again = await app.inject({ method: "POST", url: "/api/auth/login", headers: { cookie: device }, payload: { email: "ana@x.com", password: "senha-forte-1" } });
    expect(again.json().needs_code).toBeUndefined();
    expect(cookieOf(again)).toBeTruthy();
    // aparelho novo gera notificação de segurança para a própria pessoa
    const n = await app.inject({ method: "GET", url: "/api/notifications", headers: { cookie: session } });
    expect(n.json().items.some((i: any) => i.kind === "seguranca")).toBe(true);
  });

  it("cadastro só cria a conta depois do código no WhatsApp informado; número com conta não cadastra de novo", async () => {
    await (await import("../src/settings.js")).saveSettings({ signupMode: "open" });
    const { upsertUser } = await import("../src/ingest.js");
    await upsertUser("5519911110009", "Caio"); // já usa o assistente, ainda sem painel
    const form = { name: "Caio Lima", email: "caio@x.com", password: "senha-forte-1", phone: "(19) 91111-0009", accept_terms: true };
    const first = await app.inject({ method: "POST", url: "/api/auth/register", payload: form });
    expect(first.json()).toMatchObject({ needs_code: true });
    expect(cookieOf(first)).toBeUndefined();
    expect(await db.one("SELECT 1 AS ok FROM accounts WHERE email = 'caio@x.com'")).toBeUndefined();
    const job = await db.one("SELECT data FROM pgboss.job WHERE name = 'outbound.send' ORDER BY created_on DESC LIMIT 1");
    expect(job.data).toMatchObject({ phone: "5519911110009", channel: "whatsapp" });
    const real = job.data.text.match(/\d{6}/)[0];
    const { challenge } = first.json();
    // código errado não cria; o código não serve para outro e-mail
    expect((await app.inject({ method: "POST", url: "/api/auth/register", payload: { ...form, challenge, verify_code: "000000" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/register", payload: { ...form, email: "outro@x.com", challenge, verify_code: real } })).statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/api/auth/register", payload: { ...form, challenge, verify_code: real } });
    expect(ok.statusCode).toBe(200);
    expect(cookieOf(ok)).toBeTruthy();
    // o mesmo WhatsApp não vira outra conta, nem com outro e-mail
    const twice = await app.inject({ method: "POST", url: "/api/auth/register", payload: { ...form, email: "golpe@x.com" } });
    expect(twice.statusCode).toBe(409);
    await (await import("../src/settings.js")).saveSettings({ signupMode: "invite" });
  });

  it("código usado não vale de novo e sem WhatsApp conectado entra só com a senha", async () => {
    const { startChallenge, verifyChallenge } = await import("../src/logincode.js");
    const { loadAccount } = await import("../src/accounts.js");
    const row = await db.one("SELECT id FROM accounts WHERE email = 'bia@x.com'");
    let code = "";
    const ch: any = await startChallenge((await loadAccount(row.id))!, async (_p, t) => (code = t.match(/\d{6}/)![0]));
    expect(await verifyChallenge(ch.challenge, code)).toMatchObject({ ok: true });
    expect(await verifyChallenge(ch.challenge, code)).toMatchObject({ ok: false });
    // daqui em diante: WhatsApp embutido (Baileys) e desconectado
    const { config } = await import("../src/config.js");
    (config as any).WHATSAPP_PROVIDER = "baileys";
    await db.query("UPDATE wa_sessions SET status = 'disconnected'");
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "bia@x.com", password: "senha-forte-1" } });
    expect(r.json().needs_code).toBeUndefined();
    expect(cookieOf(r)).toBeTruthy();
  });

  it("notificações: cada um vê as suas, bolinha conta as não lidas e some ao ler", async () => {
    const { notify } = await import("../src/notifications.js");
    await notify({ userId: ana.id, kind: "lembrete", title: "Lembrete da Ana", link: "/agenda" });
    await notify({ userId: bia.id, kind: "lembrete", title: "Lembrete da Bia" });
    await notify({ userId: null, kind: "cliente", title: "Só para o dono" });
    await db.query("UPDATE wa_sessions SET status = 'disconnected'");
    const ana1 = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ana@x.com", password: "senha-forte-1" } }));
    const list = (await app.inject({ method: "GET", url: "/api/notifications", headers: { cookie: ana1 } })).json();
    const titles = list.items.map((i: any) => i.title);
    expect(titles).toContain("Lembrete da Ana");
    expect(titles).not.toContain("Lembrete da Bia");
    expect(titles).not.toContain("Só para o dono");
    const before = (await app.inject({ method: "GET", url: "/api/notifications/unread", headers: { cookie: ana1 } })).json().unread;
    expect(before).toBeGreaterThan(0);
    const one = list.items.find((i: any) => i.title === "Lembrete da Ana");
    await app.inject({ method: "POST", url: "/api/notifications/read", headers: { cookie: ana1 }, payload: { ids: [one.id] } });
    expect((await app.inject({ method: "GET", url: "/api/notifications/unread", headers: { cookie: ana1 } })).json().unread).toBe(before - 1);
    await app.inject({ method: "POST", url: "/api/notifications/read", headers: { cookie: ana1 }, payload: {} });
    expect((await app.inject({ method: "GET", url: "/api/notifications/unread", headers: { cookie: ana1 } })).json().unread).toBe(0);
    // dono vê as do sistema
    const owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } }));
    const o = (await app.inject({ method: "GET", url: "/api/notifications", headers: { cookie: owner } })).json();
    expect(o.items.map((i: any) => i.title)).toContain("Só para o dono");
    // sem login, nada
    expect((await app.inject({ method: "GET", url: "/api/notifications/unread" })).statusCode).toBe(401);
  });

  it("documentos: envia, baixa, ninguém mais vê (nem o dono da plataforma), apagar some", async () => {
    await db.query("UPDATE wa_sessions SET status = 'disconnected'");
    const login = async (email: string) => cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "senha-forte-1" } }));
    const a = await login("ana@x.com");
    const b = await login("bia@x.com");
    const pdf = Buffer.from("%PDF-1.4 contrato de teste");
    const up = await app.inject({ method: "POST", url: "/api/documents", headers: { cookie: a }, payload: { name: "Contrato/aluguel", mimetype: "application/pdf", base64: pdf.toString("base64"), folder: "Casa" } });
    expect(up.statusCode).toBe(200);
    const doc = up.json();
    expect(doc.name).toBe("Contrato aluguel.pdf");
    expect(doc.size).toBe(pdf.length);

    const file = await app.inject({ method: "GET", url: `/api/documents/${doc.id}/file`, headers: { cookie: a } });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toContain("application/pdf");
    expect(file.headers["content-disposition"]).toContain("attachment");
    expect(file.rawPayload.equals(pdf)).toBe(true);

    expect((await app.inject({ method: "GET", url: `/api/documents/${doc.id}/file`, headers: { cookie: b } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/documents", headers: { cookie: b } })).json().items).toHaveLength(0);
    expect((await app.inject({ method: "DELETE", url: `/api/documents/${doc.id}`, headers: { cookie: b } })).statusCode).toBe(404);

    const owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } }));
    expect((await app.inject({ method: "GET", url: "/api/documents", headers: { cookie: owner } })).json().items).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: `/api/documents/${doc.id}/file`, headers: { cookie: owner } })).statusCode).toBe(404);

    const mine = (await app.inject({ method: "GET", url: "/api/documents?q=aluguel", headers: { cookie: a } })).json();
    expect(mine.items).toHaveLength(1);
    expect(mine.usage).toMatchObject({ count: 1, bytes: pdf.length });

    expect((await app.inject({ method: "DELETE", url: `/api/documents/${doc.id}`, headers: { cookie: a } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/documents", headers: { cookie: a } })).json().items).toHaveLength(0);
  });

  it("falar com o responsável: recado guardado, sino do dono e WhatsApp do dono; teto de 3 por dia", async () => {
    const { contactOwner } = await import("../src/agent/tools/support.js");
    const { config } = await import("../src/config.js");
    const owner = config.OWNER_PHONES[0];
    const ctx: any = { user: { id: bia.id, phone: bia.phone, name: "Bia" }, timezone: "America/Sao_Paulo" };
    const r: any = await contactOwner.run({ topic: "cobranca", message: "Fui cobrada duas vezes este mês" }, ctx);
    expect(r.ok).toBe(true);
    expect(await db.one("SELECT topic, message, status FROM support_requests WHERE user_id = $1", [bia.id])).toMatchObject({ topic: "cobranca", status: "open" });
    expect(await db.one("SELECT title FROM notifications WHERE user_id IS NULL AND kind = 'suporte' ORDER BY created_at DESC LIMIT 1")).toMatchObject({ title: "Cobrança de Bia" });
    if (owner) {
      const job = await db.one("SELECT data FROM pgboss.job WHERE name = 'outbound.send' ORDER BY created_on DESC LIMIT 1");
      expect(job.data).toMatchObject({ phone: owner });
      expect(job.data.text).toContain("duas vezes");
    }
    await contactOwner.run({ topic: "duvida", message: "Outra coisa" }, ctx);
    await contactOwner.run({ topic: "duvida", message: "Mais uma" }, ctx);
    expect(((await contactOwner.run({ topic: "duvida", message: "Quarta" }, ctx)) as any).ok).toBe(false);
  });

  it("assistente guarda o arquivo recebido e manda de volta quando pedem", async () => {
    const docs = await import("../src/agent/tools/documents.js");
    const media: any[] = [];
    const ctx: any = {
      user: { id: ana.id, phone: ana.phone, name: "Ana" },
      timezone: "America/Sao_Paulo",
      inboundFiles: [{ base64: Buffer.from("%PDF boleto").toString("base64"), mimetype: "application/pdf", fileName: "boleto.pdf" }],
      outbox: { addMedia: (m: any) => (media.push(m), `m${media.length}`) },
    };
    const saved: any = await docs.documentSave.run({ name: "Boleto da luz", folder: "Contas" } as any, ctx);
    expect(saved.ok).toBe(true);
    const listed: any = await docs.documentList.run({ query: "luz" } as any, ctx);
    const id = (listed.documents ?? listed)[0].id;
    const sent: any = await docs.documentSend.run({ id } as any, ctx);
    expect(media[0]).toMatchObject({ kind: "document", mimetype: "application/pdf" });
    expect(JSON.stringify(sent)).toContain("m1");
    vi.restoreAllMocks();
  });
});
