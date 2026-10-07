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
  const all = JSON.stringify(body.messages);
  const toolNames = body.messages.flatMap((m: any) => (m.tool_calls ?? []).map((c: any) => c.function.name));

  if (system.includes("CTO de um time")) {
    const userText = String(body.messages.findLast((m: any) => m.role === "user")?.content ?? "");
    if (userText.includes("tudo bem")) {
      if (last.role === "tool") return completion("rodada extra (não deveria acontecer)");
      return completion("Tudo ótimo por aqui! 😄 E você?", [call("save_memory", { content: "Gosta de conversar de manhã" })]);
    }
    if (userText.includes("previsão")) {
      if (last.role === "tool") return completion("Amanhã faz 25° e sol ☀️");
      return completion("Opa, deixa eu ver aqui rapidinho 🔎", [call("ask_pesquisador", { message: "previsão do tempo amanhã em Campinas" })]);
    }
    if (last.role === "tool") {
      if (userText.includes("cinema")) {
        // CTO revisa e devolve ao Financeiro uma vez antes de responder
        const asks = toolNames.filter((n: string) => n === "ask_financeiro").length;
        if (asks === 1) return completion(null, [call("ask_financeiro", { message: "Inclua a pipoca no orçamento." })]);
        return completion("Dá uns R$ 50 com pipoca 🍿");
      }
      const delegated = toolNames.some((n: string) => n.startsWith("ask_"));
      return completion(delegated ? "Anotado! R$ 8,20 em Padaria (Alimentação) 🐷" : "[[silencio]]");
    }
    if (userText.includes("cinema")) return completion(null, [call("ask_financeiro", { message: "Quanto custa ir ao cinema sábado?" })]);
    if (userText.includes("padaria")) return completion(null, [call("react_to_message", { emoji: "✅" }), call("ask_financeiro", { message: "anotar gasto de R$ 8,20 na padaria" })]);
    if (userText.includes("valeu")) return completion("[[silencio]]");
    return completion("[[silencio]]");
  }

  if (system.includes("Você é o Pesquisador")) {
    if (last.role === "tool") return completion("Ingresso custa R$ 30.");
    return completion(null, [call("share_with_team", { note: "ingresso no Kinoplex: R$ 30" })]);
  }

  if (system.includes("Você é o Financeiro")) {
    const lastText = String(last.content ?? "");
    if (last.role === "user" && lastText.includes("pipoca")) {
      // a conversa continua: o Financeiro lembra do que já respondeu
      return completion(all.includes("Orçamento: R$ 30") ? "Com pipoca (R$ 20) fica R$ 50." : "Não lembro do orçamento anterior.");
    }
    if (last.role === "user" && lastText.includes("cinema")) return completion(null, [call("consult_pesquisador", { question: "Preço do ingresso sábado?" })]);
    if (last.role === "tool" && toolNames.includes("consult_pesquisador")) return completion("Orçamento: R$ 30 do ingresso.");
    if (last.role === "tool") return completion("Gasto registrado: R$ 8,20, Alimentação.");
    return completion(null, [call("add_transaction", { kind: "expense", amount: 8.2, category: "Alimentação", description: "Padaria" })]);
  }
  return completion("?");
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
      { type: "reaction", emoji: "💸", messageId: "in1" },
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
    // a reação do tema sai sozinha, sem IA; o CTO fica em silêncio
    expect(channel.sent).toEqual([{ type: "reaction", emoji: "🙏", messageId: "in2" }]);
  });

  it("pergunta simples: responde junto da reação, numa rodada só do modelo", async () => {
    await db.query("INSERT INTO messages (conversation_id, role, content, external_id) VALUES ($1, 'user', 'oi, tudo bem?', 'in4')", [convId]);
    const channel = new channels.PlaygroundChannel();
    const r = await mod.processConversation(convId, { trigger: "playground", channel });
    expect(channel.sent).toEqual([
      { type: "reaction", emoji: "👋", messageId: "in4" },
      { type: "text", text: "Tudo ótimo por aqui! 😄 E você?" },
    ]);
    const llm = await db.one("SELECT COUNT(*)::int AS n FROM execution_steps WHERE execution_id = $1 AND type = 'llm'", [r.executionId]);
    expect(llm.n).toBe(1);
  });

  it("pesquisa: avisa na hora que vai ver e depois manda o resultado", async () => {
    await db.query("INSERT INTO messages (conversation_id, role, content, external_id) VALUES ($1, 'user', 'qual a previsão pra amanhã?', 'in5')", [convId]);
    const channel = new channels.PlaygroundChannel();
    const r = await mod.processConversation(convId, { trigger: "playground", channel });
    expect(channel.sent).toEqual([
      { type: "reaction", emoji: "🌦️", messageId: "in5" },
      { type: "text", text: "Opa, deixa eu ver aqui rapidinho 🔎" },
      { type: "text", text: "Amanhã faz 25° e sol ☀️" },
    ]);
    const names = (await db.many("SELECT name FROM execution_steps WHERE execution_id = $1 AND type <> 'llm' ORDER BY id", [r.executionId])).map((s) => s.name);
    expect(names[0]).toBe("aviso_andamento");
    expect(names.at(-1)).toBe("enviar_texto");
  });

  it("especialistas conversam entre si e o CTO devolve trabalho antes de responder", async () => {
    await db.query("INSERT INTO messages (conversation_id, role, content, external_id) VALUES ($1, 'user', 'quanto gasto pra ir ao cinema?', 'in3')", [convId]);
    const channel = new channels.PlaygroundChannel();
    const r = await mod.processConversation(convId, { trigger: "playground", channel });
    expect(channel.sent).toEqual([
      { type: "reaction", emoji: "💸", messageId: "in3" },
      { type: "text", text: "Dá uns R$ 50 com pipoca 🍿" },
    ]);

    const steps = await db.many("SELECT id, parent_id, agent, type, name, output FROM execution_steps WHERE execution_id = $1 ORDER BY id", [r.executionId]);
    const names = steps.filter((s) => s.type !== "llm").map((s) => `${s.agent}:${s.name}`);
    expect(names).toEqual([
      "cto:ask_financeiro",
      "financeiro:consult_pesquisador",
      "pesquisador:share_with_team",
      "cto:ask_financeiro",
      "cto:enviar_texto",
    ]);
    // segunda conversa com o Financeiro continuou a primeira
    const followUp = steps.filter((s) => s.name === "ask_financeiro")[1];
    expect(followUp.output).toEqual({ report: "Com pipoca (R$ 20) fica R$ 50." });
  });
});
