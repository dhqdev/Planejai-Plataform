import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Recursos novos ponta a ponta (Postgres real + OpenRouter falso):
 * comprovante em foto vira gasto sozinho, documento é lido sem gastar token, parcelas fecham
 * no centavo, memória curta no Redis e painéis super admin / admin com cadastro.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);

let server: http.Server;
let seq = 0;
const call = (name: string, args: unknown) => ({ id: `f${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const completion = (content: string | null, tool_calls?: unknown[]) => ({
  model: "fake/model",
  choices: [{ message: { role: "assistant", content, tool_calls }, finish_reason: tool_calls ? "tool_calls" : "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.000001 },
});
const seen: string[] = [];

function fakeOpenRouter(body: any) {
  const first = body.messages[0];
  // visão: foto de comprovante
  if (Array.isArray(first.content)) return completion("FINANCEIRO: tipo=comprovante; valor_total=45.90; data=2026-10-05; estabelecimento=Pizzaria Bella; pago=sim\nPix para Pizzaria Bella.");
  const system: string = first.content;
  const last = body.messages.at(-1);
  if (system.includes("CTO de um time")) {
    const userText = String(body.messages.findLast((m: any) => m.role === "user")?.content ?? "");
    seen.push(userText);
    const msgId = userText.match(/\[msg_id=(\d+)\]/)?.[1];
    if (last.role === "tool") return completion("Anotado ✅");
    if (userText.includes("FINANCEIRO:")) {
      return completion(null, [
        call("react_to_message", { emoji: "✅" }),
        call("add_transaction", { kind: "expense", amount: 45.9, category: "Alimentação", merchant: "Pizzaria Bella", date: "2026-10-05", source: "comprovante", message_id: msgId }),
      ]);
    }
    return completion("ok");
  }
  return completion("?");
}

describe.skipIf(!enabled)("recursos (e2e)", () => {
  let mod: typeof import("../src/agent/orchestrator.js");
  let db: typeof import("../src/db/pool.js");
  let channels: typeof import("../src/channels/index.js");
  let user: any;
  let convId: string;

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
    mod = await import("../src/agent/orchestrator.js");
    channels = await import("../src/channels/index.js");
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    user = await upsertUser("5519911111111", "Ana");
    await db.query("UPDATE users SET status = 'active' WHERE id = $1", [user.id]);
    convId = (await upsertConversation(user.id, "playground", "teste-recursos")).id;
  });

  afterAll(async () => {
    server?.close();
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  it("foto de comprovante vira gasto sozinho, sem duplicar se reprocessar", async () => {
    const img = { base64: Buffer.from("fake-jpeg").toString("base64"), mimetype: "image/jpeg" };
    const m = await db.one(
      "INSERT INTO messages (conversation_id, role, content, external_id, media, meta) VALUES ($1, 'user', '', 'img1', $2, $3) RETURNING id",
      [convId, img, { kind: "image" }],
    );
    const channel = new channels.PlaygroundChannel();
    await mod.processConversation(convId, { trigger: "playground", channel });
    expect(channel.sent.filter((s: any) => s.type === "reaction").at(-1)).toEqual({ type: "reaction", emoji: "✅", messageId: "img1" });
    const tx = await db.many("SELECT amount, category, merchant, source, external_ref FROM transactions WHERE user_id = $1", [user.id]);
    expect(tx).toEqual([{ amount: 45.9, category: "Alimentação", merchant: "Pizzaria Bella", source: "comprovante", external_ref: `${m.id}:0` }]);
    // a conversa não fica no banco (já está no WhatsApp): só na memória curta do Redis, já interpretada
    const stored = await db.many("SELECT id FROM messages WHERE id = $1", [m.id]);
    expect(stored).toEqual([]);
    const { recentShort, cacheGet } = await import("../src/shortmem.js");
    expect((await recentShort(convId, 10))?.some((e) => e.text.includes("valor_total=45.90"))).toBe(true);
    // a mesma foto de novo não paga visão outra vez: a interpretação fica no cache
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(img.base64).digest("hex").slice(0, 40);
    expect(((await cacheGet<any>(`media:image:${hash}`)) as any).image_description).toContain("Pizzaria Bella");

    // mesmo comprovante de novo (reprocessamento): não duplica
    const { addTransaction } = await import("../src/agent/tools/finance.js");
    const ctx: any = { user, timezone: "America/Sao_Paulo" };
    const again: any = await addTransaction.run({ kind: "expense", amount: 45.9, category: "Alimentação", message_id: String(m.id) }, ctx);
    expect(again.duplicate).toBe(true);
  });

  it("documento é lido localmente e entra resumido no contexto", async () => {
    const csv = "data,descricao,valor\n2026-10-01,Mercado,250.40\n2026-10-02,Uber,32.10\n";
    await db.query("INSERT INTO messages (conversation_id, role, content, external_id, media, meta) VALUES ($1, 'user', 'meu extrato', 'doc1', $2, $3)", [
      convId,
      { base64: Buffer.from(csv).toString("base64"), mimetype: "text/csv", fileName: "extrato.csv" },
      { kind: "document", fileName: "extrato.csv" },
    ]);
    await mod.processConversation(convId, { trigger: "playground", channel: new channels.PlaygroundChannel() });
    // o texto do documento fica 24h no Redis para read_document, mesmo sem a mensagem no banco
    const { readDocument } = await import("../src/agent/tools/core.js");
    const { cacheGet } = await import("../src/shortmem.js");
    const keys = await (async () => {
      const { Redis } = await import("ioredis");
      const r = new Redis(process.env.REDIS_URL!);
      const k = await r.keys(`pj:cache:doc:${convId}:*`);
      await r.quit();
      return k;
    })();
    expect(keys.length).toBe(1);
    const msgId = Number(keys[0]!.split(":").at(-1));
    expect(await cacheGet<string>(`doc:${convId}:${msgId}`)).toContain("Mercado,250.40");
    const read: any = await readDocument.run({ message_id: msgId, query: "uber" }, { conversation: { id: convId } } as any);
    expect(read.matches).toContain("Uber,32.10");
    expect(seen.at(-1)).toContain("[documento extrato.csv]");
    expect(seen.at(-1)).toContain("Uber,32.10");
  });

  it("parcelas fecham no centavo e o resumo soma certo", async () => {
    const { addTransaction, financeSummary } = await import("../src/agent/tools/finance.js");
    const u = (await db.one("INSERT INTO users (phone, name, status) VALUES ('5511900000001', 'Bia', 'active') RETURNING *")) as any;
    const ctx: any = { user: u, timezone: "America/Sao_Paulo" };
    const r: any = await addTransaction.run({ kind: "expense", amount: 100, category: "Compras", description: "Tênis", installments: 3, date: "2026-01-15" }, ctx);
    expect(r.installment_values).toEqual(["R$ 33,34", "R$ 33,33", "R$ 33,33"]);
    const rows = await db.many("SELECT amount FROM transactions WHERE user_id = $1 ORDER BY occurred_at", [u.id]);
    expect(rows.map((x) => x.amount)).toEqual([33.34, 33.33, 33.33]);
    // 0,1 + 0,2 em ponto flutuante dá 0,30000000000000004; no banco e no resumo tem que dar 0,30
    await addTransaction.run({ kind: "expense", amount: 0.1, category: "Outros", date: "2026-03-10" }, ctx);
    await addTransaction.run({ kind: "expense", amount: 0.2, category: "Outros", date: "2026-03-11" }, ctx);
    await addTransaction.run({ kind: "income", amount: 1500.55, category: "Salário", date: "2026-03-05" }, ctx);
    const s: any = await financeSummary.run({ month: "2026-03" }, ctx);
    expect(s.expenses).toBe("R$ 33,63");
    expect(s.income).toBe("R$ 1.500,55");
    expect(s.balance).toBe("R$ 1.466,92");
    expect(s.previous_month_expenses).toBe("R$ 33,33");
  });

  it.skipIf(!process.env.REDIS_URL)("memória curta fica no Redis com validade de 24h", async () => {
    const { recentShort } = await import("../src/shortmem.js");
    const { Redis } = await import("ioredis");
    const entries = await recentShort(convId, 50);
    expect(entries?.some((e) => e.role === "user" && e.text.includes("[documento extrato.csv]"))).toBe(true);
    expect(entries?.some((e) => e.role === "assistant")).toBe(true);
    const r = new Redis(process.env.REDIS_URL!);
    const ttl = await r.ttl(`pj:conv:${convId}:msgs`);
    await r.quit();
    expect(ttl).toBeGreaterThan(23 * 3600);
    expect(ttl).toBeLessThanOrEqual(24 * 3600);
  });

  it("memória curta vira resumo antes de expirar e nenhuma conversa fica no banco", async () => {
    const left = await db.one("SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1", [convId]);
    expect(left.n).toBe(0);
    const { summarizeConversation } = await import("../src/agent/orchestrator.js");
    await summarizeConversation(convId, { olderThanMs: 0 });
    const conv = await db.one("SELECT summary, summary_ts FROM conversations WHERE id = $1", [convId]);
    expect(conv.summary).toBeTruthy();
    expect(Number(conv.summary_ts)).toBeGreaterThan(0);
    const { purgeOld } = await import("../src/maintenance.js");
    await purgeOld();
    // o gasto continua lá
    const tx = await db.one("SELECT COUNT(*)::int AS n FROM transactions WHERE user_id = $1", [user.id]);
    expect(tx.n).toBe(1);
  });

  it("o Financeiro tem controle total: lista com filtro, corrige, recategoriza e apaga (em lote só com confirmação)", async () => {
    const fin = await import("../src/agent/tools/finance.js");
    const leo = await db.one("INSERT INTO users (phone, name, status) VALUES ('5519955556666', 'Leo', 'active') RETURNING *");
    const ctx: any = { user: leo, timezone: "America/Sao_Paulo" };
    for (const [amount, description] of [[81, "padaria"], [30, "uber casa"], [25, "uber trabalho"]] as const) await fin.addTransaction.run({ kind: "expense", amount, description }, ctx);
    const ubers: any = await fin.listTransactions.run({ search: "uber" }, ctx);
    expect(ubers.count).toBe(2);
    const bread: any = await fin.listTransactions.run({ search: "padaria" }, ctx);
    // "era 18 e não 81"
    const fixed: any = await fin.updateTransaction.run({ ids: [bread.items[0].id], amount: 18 }, ctx);
    expect(fixed).toMatchObject({ ok: true, updated: 1 });
    expect(fixed.items[0].amount).toBe("R$ 18,00");
    // recategoriza os dois de uma vez
    const moved: any = await fin.updateTransaction.run({ ids: ubers.items.map((i: any) => i.id), category: "Lazer" }, ctx);
    expect(moved.updated).toBe(2);
    // outra pessoa não mexe nos lançamentos do Leo
    const other: any = { user: { id: (await db.one("SELECT id FROM users WHERE name = 'Bia'")).id }, timezone: "America/Sao_Paulo" };
    expect(await fin.updateTransaction.run({ ids: [bread.items[0].id], amount: 1 }, other)).toMatchObject({ ok: false });
    expect(await fin.deleteTransaction.run({ ids: [bread.items[0].id] }, other)).toMatchObject({ ok: false, deleted: 0 });
    // apagar por filtro pede confirmação e mostra quantos/total
    const ask: any = await fin.deleteTransaction.run({ search: "uber" }, ctx);
    expect(ask).toMatchObject({ needs_confirmation: true, count: 2, total: "R$ 55,00" });
    expect((await fin.listTransactions.run({}, ctx) as any).count).toBe(3);
    expect(await fin.deleteTransaction.run({ search: "uber", confirmed_by_user: true }, ctx)).toMatchObject({ ok: true, deleted: 2 });
    // um item apontado sai sem confirmação
    expect(await fin.deleteTransaction.run({ id: bread.items[0].id }, ctx)).toMatchObject({ ok: true, deleted: 1 });
    // finanças de um contato só se ele compartilhou
    expect(await fin.financeSummary.run({ of_contact: "Bia" }, ctx)).toMatchObject({ error: expect.stringContaining("não é contato") });
  });

  it("categoriza sozinho, avisa limite de gastos e desenha gráfico sem IA", async () => {
    const fin = await import("../src/agent/tools/finance.js");
    const { Outbox } = await import("../src/agent/tools/types.js");
    const rita = await db.one("INSERT INTO users (phone, name, status) VALUES ('5519933334444', 'Rita', 'active') RETURNING *");
    const ctx: any = { user: rita, timezone: "America/Sao_Paulo", outbox: new Outbox() };
    // regra por palavra
    const a: any = await fin.addTransaction.run({ kind: "expense", amount: 38, description: "uber pro trabalho" }, ctx);
    expect(a.category).toBe("Transporte");
    // aprende com o que a pessoa já usou: mesmo lugar, mesma categoria
    await db.query("UPDATE transactions SET category = 'Lazer' WHERE id = $1", [a.ids[0]]);
    const b: any = await fin.addTransaction.run({ kind: "expense", amount: 20, description: "uber pro trabalho" }, ctx);
    expect(b.category).toBe("Lazer");
    // limite: avisa uma vez em 80% e uma vez ao estourar
    await fin.setBudget.run({ category: "Alimentação", amount: 100 }, ctx);
    const c1: any = await fin.addTransaction.run({ kind: "expense", amount: 85, description: "almoço no restaurante" }, ctx);
    expect(c1.category).toBe("Alimentação");
    expect(c1.budget_alert).toMatch(/85% do limite de Alimentação/);
    const c2: any = await fin.addTransaction.run({ kind: "expense", amount: 5, description: "café" }, ctx);
    expect(c2.budget_alert).toBeUndefined();
    const c3: any = await fin.addTransaction.run({ kind: "expense", amount: 20, description: "lanche" }, ctx);
    expect(c3.budget_alert).toMatch(/Estourou o limite de Alimentação/);
    // gráfico: PNG de verdade, pronto para o WhatsApp
    const g: any = await fin.makeChart.run({ kind: "categorias" }, ctx);
    const img = ctx.outbox.media.get(g.media_id);
    expect(Buffer.from(img.base64, "base64").subarray(1, 4).toString()).toBe("PNG");
    const l: any = await fin.makeChart.run({ kind: "limites" }, ctx);
    expect(l.media_id).toBeTruthy();
  }, 60_000);

  it("lembrete que passou some junto com a memória sobre ele; recorrente continua", async () => {
    const r = await db.one(
      "INSERT INTO reminders (user_id, conversation_id, intent, due_at) VALUES ($1, $2, 'lembrar o David de ligar para o dentista', now()) RETURNING id",
      [user.id, convId],
    );
    await db.query("INSERT INTO memories (user_id, content) VALUES ($1, 'Precisa ligar para o dentista hoje'), ($1, 'Mora em Campinas')", [user.id]);
    const { afterFire } = await import("../src/reminders.js");
    await afterFire(r.id, true);
    expect(await db.one("SELECT COUNT(*)::int AS n FROM reminders WHERE id = $1", [r.id])).toEqual({ n: 0 });
    const mems = await db.many("SELECT content FROM memories WHERE user_id = $1", [user.id]);
    expect(mems.map((m: any) => m.content)).toContain("Mora em Campinas");
    expect(mems.map((m: any) => m.content)).not.toContain("Precisa ligar para o dentista hoje");
  });

  it("painéis: cadastro vira admin com acesso só aos próprios dados; finanças e agenda são particulares até a pessoa compartilhar", async () => {
    const { buildServer } = await import("../src/api/server.js");
    const app = await buildServer();
    const cookieOf = (res: any) => String(res.headers["set-cookie"]).split(";")[0]!;

    // padrão é só por convite: sem código não entra
    const noCode = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Zé", email: "ze@x.com", password: "senha-forte", phone: "(19) 92222-2222", accept_terms: true } });
    expect(noCode.statusCode).toBe(403);
    await (await import("../src/settings.js")).saveSettings({ signupMode: "approval" });
    // cadastro com aprovação
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Ana", email: "ana@x.com", password: "senha-forte", phone: "(19) 91111-1111", accept_terms: true } });
    expect(reg.json()).toMatchObject({ pending: true });
    const blocked = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ana@x.com", password: "senha-forte" } });
    expect(blocked.statusCode).toBe(403);

    // dono da stack entra e aprova
    const owner = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } });
    expect(owner.json()).toMatchObject({ role: "superadmin", owner: true });
    const sup = cookieOf(owner);
    const accounts = (await app.inject({ method: "GET", url: "/api/accounts", headers: { cookie: sup } })).json();
    const ana = accounts.find((a: any) => a.email === "ana@x.com");
    expect(ana.status).toBe("pending");
    await app.inject({ method: "PATCH", url: `/api/accounts/${ana.id}`, headers: { cookie: sup }, payload: { status: "active" } });

    // admin entra: vê só os próprios gastos (ligado pelo número), não vê config
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ana@x.com", password: "senha-forte" } });
    expect(login.json()).toMatchObject({ role: "admin", linked: true });
    const adm = cookieOf(login);
    const fin = (await app.inject({ method: "GET", url: "/api/finance?month=2026-10", headers: { cookie: adm } })).json();
    expect(fin.transactions.map((t: any) => t.user_name)).toEqual(["Ana"]);
    const all = (await app.inject({ method: "GET", url: "/api/finance?month=2026-03", headers: { cookie: adm } })).json();
    expect(all.transactions).toEqual([]); // os de março são da Bia
    // nem papel gravado no banco nem pedido pelo painel vira super admin: só o dono (ADMIN_EMAIL)
    await db.query("UPDATE accounts SET role = 'superadmin' WHERE email = 'ana@x.com'");
    await app.inject({ method: "PATCH", url: `/api/accounts/${ana.id}`, headers: { cookie: sup }, payload: { role: "superadmin" } });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: adm } })).json()).toMatchObject({ role: "admin" });
    expect((await app.inject({ method: "GET", url: "/api/me/tabs", headers: { cookie: adm } })).json()).toMatchObject({ all: false, modules: [] });
    for (const url of ["/api/integrations", "/api/settings", "/api/executions", "/api/executions/summary", "/api/accounts", "/api/overview", "/api/queues", "/api/costs", `/api/clients/${ana.user_id ?? ana.id}/usage`]) {
      expect((await app.inject({ method: "GET", url, headers: { cookie: adm } })).statusCode).toBe(403);
    }
    // particular: nem o dono vê as finanças da Bia, nem pedindo por ?user=
    const bia = await db.one("SELECT id FROM users WHERE name = 'Bia'");
    const supFin = (await app.inject({ method: "GET", url: "/api/finance?month=2026-03", headers: { cookie: sup } })).json();
    expect(supFin.transactions).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/api/finance?month=2026-03&user=${bia.id}`, headers: { cookie: adm } })).statusCode).toBe(403);
    // compartilhar só com contato; depois disso a Ana vê as finanças da Bia (só leitura), mas não a agenda
    const { setShare } = await import("../src/sharing.js");
    await expect(setShare(bia.id, user.id, "finance", true)).rejects.toThrow(/contato/);
    await db.query("INSERT INTO contacts (user_id, contact_id) VALUES ($1, $2), ($2, $1)", [bia.id, user.id]);
    await setShare(bia.id, user.id, "finance", true);
    const shares = (await app.inject({ method: "GET", url: "/api/shares", headers: { cookie: adm } })).json();
    expect(shares.withMe).toMatchObject([{ id: bia.id, scopes: ["finance"] }]);
    expect(shares.mine).toMatchObject([{ id: bia.id, scopes: [] }]);
    const seen = (await app.inject({ method: "GET", url: `/api/finance?month=2026-03&user=${bia.id}`, headers: { cookie: adm } })).json();
    expect(seen).toMatchObject({ readonly: true });
    expect(seen.transactions.length).toBe(4);
    const range0 = `from=${new Date().toISOString()}&to=${new Date(Date.now() + 7 * 86400_000).toISOString()}`;
    expect((await app.inject({ method: "GET", url: `/api/calendar?${range0}&user=${bia.id}`, headers: { cookie: adm } })).statusCode).toBe(403);
    // só leitura: apagar um lançamento da Bia não funciona
    const del = await app.inject({ method: "DELETE", url: `/api/finance/${seen.transactions[0].id}`, headers: { cookie: adm } });
    expect(del.json()).toEqual({ ok: false });
    // a Ana libera a agenda dela para a Bia pelo painel
    const put = await app.inject({ method: "PUT", url: "/api/shares", headers: { cookie: adm }, payload: { contact: bia.id, scope: "agenda", on: true } });
    expect(put.json()).toEqual({ ok: true });
    expect(await db.one("SELECT count(*)::int AS n FROM shares WHERE owner_id = $1 AND viewer_id = $2 AND scope = 'agenda'", [user.id, bia.id])).toEqual({ n: 1 });
    // agenda: a admin cria um lembrete pelo painel, arrasta para outro horário e vê no calendário
    const at = new Date(Date.now() + 2 * 86400_000);
    const local = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(at).replace(" ", "T");
    const created = await app.inject({ method: "POST", url: "/api/reminders", headers: { cookie: adm }, payload: { intent: "Levar o cachorro no veterinário", at: local } });
    expect(created.statusCode).toBe(200);
    const later = new Date(at.getTime() + 3600_000);
    const moved = await app.inject({ method: "PATCH", url: `/api/reminders/${created.json().id}`, headers: { cookie: adm }, payload: { at: later.toISOString() } });
    expect(moved.json()).toEqual({ ok: true });
    const range = `from=${new Date().toISOString()}&to=${new Date(Date.now() + 7 * 86400_000).toISOString()}`;
    const cal = (await app.inject({ method: "GET", url: `/api/calendar?${range}`, headers: { cookie: adm } })).json();
    const ev = cal.events.find((e: any) => e.title.startsWith("Levar o cachorro"));
    expect(Math.abs(new Date(ev.start).getTime() - later.getTime())).toBeLessThan(60_000);
    expect(cal.events.every((e: any) => e.person === "Ana")).toBe(true);

    // aprovar a conta liberou o número no WhatsApp
    const wa = await db.one("SELECT status FROM users WHERE id = $1", [user.id]);
    expect(wa.status).toBe("active");
    await app.close();
  });
});
