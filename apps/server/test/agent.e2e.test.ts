import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Teste ponta a ponta do time de agentes com Postgres real e um OpenRouter falso:
 * CTO reage, delega para o especialista, a tool grava no banco e a resposta sai no canal.
 * Roda quando TEST_DATABASE_URL está definido (no CI há um serviço Postgres).
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);

let server: http.Server;
let seq = 0;
const call = (name: string, args: unknown) => ({ id: `c${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const completion = (content: string | null, tool_calls?: unknown[]) => ({
  model: "fake/model",
  choices: [{ message: { role: "assistant", content, tool_calls }, finish_reason: tool_calls ? "tool_calls" : "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.000001 },
});

function fakeOpenRouter(body: any) {
  const system: string = body.messages[0].content;
  const last = body.messages.at(-1);
  if (system.includes("CTO de um time")) {
    if (last.role === "tool") {
      const calls = body.messages.findLast((m: any) => m.tool_calls)?.tool_calls ?? [];
      const delegated = calls.some((c: any) => c.function.name.startsWith("ask_"));
      return completion(delegated ? "Anotado! R$ 8,20 em Padaria (Alimentação) 🐷" : "[[silencio]]");
    }
    const text = String(last.content);
    if (text.includes("padaria")) return completion(null, [call("react_to_message", { emoji: "✅" }), call("ask_financeiro", { task: "anotar gasto de R$ 8,20 na padaria" })]);
    if (text.includes("valeu")) return completion(null, [call("react_to_message", { emoji: "🙏" })]);
    return completion("[[silencio]]");
  }
  if (last.role === "tool") return completion("Gasto registrado: R$ 8,20, Alimentação.");
  return completion(null, [call("add_transaction", { kind: "expense", amount: 8.2, category: "Alimentação", description: "Padaria" })]);
}

describe.skipIf(!enabled)("time de agentes (e2e)", () => {
  let mod: typeof import("../src/agent/orchestrator.js");
  let db: typeof import("../src/db/pool.js");
  let channels: typeof import("../src/channels/index.js");
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
    const user = await upsertUser("5519900000000", "David");
    await db.query("UPDATE users SET status = 'active' WHERE id = $1", [user.id]);
    convId = (await upsertConversation(user.id, "playground", "teste")).id;
  });

  afterAll(async () => {
    server?.close();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  it("anota um gasto delegando ao Financeiro e reage à mensagem", async () => {
    await db.query("INSERT INTO messages (conversation_id, role, content, external_id) VALUES ($1, 'user', 'gastei 8,20 na padaria', 'in1')", [convId]);
    const channel = new channels.PlaygroundChannel();
    const r = await mod.processConversation(convId, { trigger: "playground", channel });

    expect(channel.sent).toEqual([
      { type: "reaction", emoji: "✅", messageId: "in1" },
      { type: "text", text: "Anotado! R$ 8,20 em Padaria (Alimentação) 🐷" },
    ]);
    const tx = await db.one("SELECT amount, category FROM transactions");
    expect(tx).toEqual({ amount: 8.2, category: "Alimentação" });

    const steps = await db.many("SELECT agent, type, name, status FROM execution_steps WHERE execution_id = $1 ORDER BY id", [r.executionId]);
    expect(steps.map((s) => `${s.agent}:${s.type}:${s.name}`)).toEqual([
      "cto:llm:cto · passo 1",
      "cto:tool:react_to_message",
      "cto:delegate:ask_financeiro",
      "financeiro:llm:financeiro · passo 1",
      "financeiro:tool:add_transaction",
      "financeiro:llm:financeiro · passo 2",
      "cto:llm:cto · passo 2",
      "cto:channel:enviar_texto",
    ]);
    expect(steps.every((s) => s.status === "success")).toBe(true);
    const pending = await db.one("SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1 AND processed = false", [convId]);
    expect(pending.n).toBe(0);
  });

  it("só reage, sem mandar texto, quando a mensagem não pede resposta", async () => {
    await db.query("INSERT INTO messages (conversation_id, role, content, external_id) VALUES ($1, 'user', 'valeu!', 'in2')", [convId]);
    const channel = new channels.PlaygroundChannel();
    await mod.processConversation(convId, { trigger: "playground", channel });
    expect(channel.sent).toEqual([{ type: "reaction", emoji: "🙏", messageId: "in2" }]);
  });
});
