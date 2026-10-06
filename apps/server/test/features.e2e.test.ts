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
    expect(channel.sent[0]).toEqual({ type: "reaction", emoji: "✅", messageId: "img1" });
    const tx = await db.many("SELECT amount, category, merchant, source, external_ref FROM transactions WHERE user_id = $1", [user.id]);
    expect(tx).toEqual([{ amount: 45.9, category: "Alimentação", merchant: "Pizzaria Bella", source: "comprovante", external_ref: `${m.id}:0` }]);
    // a foto não fica guardada no banco depois de interpretada
    const stored = await db.one("SELECT media, meta FROM messages WHERE id = $1", [m.id]);
    expect(stored.media.base64).toBeUndefined();
    expect(stored.meta.image_description).toContain("valor_total=45.90");

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
    const row = await db.one("SELECT meta FROM messages WHERE external_id = 'doc1'");
    expect(row.meta.doc_text).toContain("Mercado,250.40");
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

  it("limpeza: mensagens com mais de 24h viram resumo e são apagadas", async () => {
    await db.query("UPDATE messages SET created_at = now() - interval '30 hours' WHERE conversation_id = $1", [convId]);
    const { purgeOld } = await import("../src/maintenance.js");
    const r = await purgeOld();
    expect(r.messages).toBeGreaterThan(0);
    const left = await db.one("SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1", [convId]);
    expect(left.n).toBe(0);
    const conv = await db.one("SELECT summary FROM conversations WHERE id = $1", [convId]);
    expect(conv.summary).toBeTruthy();
    // o gasto continua lá
    const tx = await db.one("SELECT COUNT(*)::int AS n FROM transactions WHERE user_id = $1", [user.id]);
    expect(tx.n).toBe(1);
  });

  it("painéis: cadastro vira admin com acesso só aos próprios dados; super admin vê tudo", async () => {
    const { buildServer } = await import("../src/api/server.js");
    const app = await buildServer();
    const cookieOf = (res: any) => String(res.headers["set-cookie"]).split(";")[0]!;

    // cadastro (modo padrão: aprovação)
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Ana", email: "ana@x.com", password: "senha-forte", phone: "(19) 91111-1111" } });
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
    for (const url of ["/api/integrations", "/api/settings", "/api/executions", "/api/people", "/api/accounts", "/api/overview"]) {
      expect((await app.inject({ method: "GET", url, headers: { cookie: adm } })).statusCode).toBe(403);
    }
    const supFin = (await app.inject({ method: "GET", url: "/api/finance?month=2026-03", headers: { cookie: sup } })).json();
    expect(supFin.transactions.length).toBe(4);
    // aprovar a conta liberou o número no WhatsApp
    const wa = await db.one("SELECT status FROM users WHERE id = $1", [user.id]);
    expect(wa.status).toBe("active");
    await app.close();
  });
});
