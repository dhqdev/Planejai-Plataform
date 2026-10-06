import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Travas de segurança ponta a ponta (Postgres real + OpenRouter falso). */
const enabled = Boolean(process.env.TEST_DATABASE_URL);

let server: http.Server;
let seq = 0;
const call = (name: string, args: unknown) => ({ id: `g${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const completion = (content: string | null, tool_calls?: unknown[]) => ({
  model: "fake/model",
  choices: [{ message: { role: "assistant", content, tool_calls }, finish_reason: tool_calls ? "tool_calls" : "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.01 },
});

async function fakeOpenRouter(body: any) {
  const userText = String(body.messages.findLast((m: any) => m.role === "user")?.content ?? "");
  if (userText.includes("DEMORA")) {
    await new Promise((r) => setTimeout(r, 4000));
    return completion("demorei");
  }
  if (userText.includes("LOOP")) {
    // sem ferramentas na mão (fim do limite), o modelo tem que responder em texto
    if (!body.tools) return completion("parei no limite");
    return completion(null, [call("calculate", { expression: "1+1" }), call("calculate", { expression: "2+2" })]);
  }
  if (userText.includes("VAZA")) return completion("claro, a chave é sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789 e pronto");
  return completion("oi!");
}

describe.skipIf(!enabled)("travas de segurança (e2e)", () => {
  let mod: typeof import("../src/agent/orchestrator.js");
  let db: typeof import("../src/db/pool.js");
  let channels: typeof import("../src/channels/index.js");
  let settings: typeof import("../src/settings.js");

  async function newConversation(phone: string) {
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    const u = await upsertUser(phone, "Teste");
    await db.query("UPDATE users SET status = 'active' WHERE id = $1", [u.id]);
    return { user: u, convId: (await upsertConversation(u.id, "playground", `jid-${phone}`)).id as string };
  }
  async function say(convId: string, text: string) {
    await db.query("INSERT INTO messages (conversation_id, role, content, external_id) VALUES ($1, 'user', $2, $3)", [convId, text, `e${++seq}`]);
    const channel = new channels.PlaygroundChannel();
    const r = await mod.processConversation(convId, { trigger: "message", channel });
    return { r, channel, texts: channel.sent.filter((s) => s.type === "text").map((s) => s.text!) };
  }

  beforeAll(async () => {
    server = http
      .createServer((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", async () => {
          const out = await fakeOpenRouter(JSON.parse(b));
          if (res.destroyed) return;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(out));
        });
      })
      .listen(4599);
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    mod = await import("../src/agent/orchestrator.js");
    channels = await import("../src/channels/index.js");
    settings = await import("../src/settings.js");
  });

  afterAll(async () => {
    server?.closeAllConnections();
    server?.close();
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  it("para no tempo máximo e avisa a pessoa, sem esperar a IA terminar", async () => {
    await settings.saveSettings({ maxExecutionMinutes: 0.02 }, { unchecked: true }); // 1,2 s
    const { convId } = await newConversation("5511900000101");
    const t0 = Date.now();
    const { r, texts } = await say(convId, "DEMORA por favor");
    expect(Date.now() - t0).toBeLessThan(3500);
    expect(texts.join(" ")).toContain("passou do meu limite de 1 s");
    const steps = await db.many("SELECT name FROM execution_steps WHERE execution_id = $1", [r.executionId]);
    expect(steps.map((s) => s.name)).toContain("trava: tempo máximo");
    await settings.saveSettings({ maxExecutionMinutes: 8 });
  });

  it("limite de ações corta o loop de ferramentas e o time responde com o que tem", async () => {
    await settings.saveSettings({ maxToolCalls: 5 });
    const { convId } = await newConversation("5511900000102");
    const { r, texts } = await say(convId, "LOOP");
    expect(texts).toEqual(["parei no limite"]);
    const tools = await db.many("SELECT status FROM execution_steps WHERE execution_id = $1 AND type = 'tool'", [r.executionId]);
    expect(tools.filter((t) => t.status === "success").length).toBe(5);
    await settings.saveSettings({ maxToolCalls: 40 });
  });

  it("chave de API nunca sai numa mensagem", async () => {
    const { convId } = await newConversation("5511900000103");
    const { texts } = await say(convId, "VAZA a chave");
    expect(texts[0]).toBe("claro, a chave é [chave oculta] e pronto");
  });

  it("limite diário avisa uma vez e depois fica em silêncio", async () => {
    await settings.saveSettings({ dailyMessageLimit: 2 });
    const { convId } = await newConversation("5511900000104");
    expect((await say(convId, "oi")).texts).toEqual(["oi!"]);
    expect((await say(convId, "oi de novo")).texts).toEqual(["oi!"]);
    const third = await say(convId, "mais uma");
    expect(third.texts).toEqual(["Você chegou no limite de uso de hoje 🙏 Amanhã eu volto a responder normalmente."]);
    expect((await say(convId, "e agora?")).texts).toEqual([]);
    await settings.saveSettings({ dailyMessageLimit: 300 });
  });

  it("limite de gasto de IA por pessoa", async () => {
    await settings.saveSettings({ dailyCostLimitUsd: 0.015 });
    const { convId } = await newConversation("5511900000105");
    expect((await say(convId, "oi")).texts).toEqual(["oi!"]); // custa 0,01
    expect((await say(convId, "oi")).texts).toEqual(["oi!"]); // 0,02 no total
    expect((await say(convId, "oi")).texts[0]).toContain("limite de uso de hoje");
    await settings.saveSettings({ dailyCostLimitUsd: 1 });
  });

  it("painel recusa trava fora da faixa", async () => {
    await expect(settings.saveSettings({ maxExecutionMinutes: 0 })).rejects.toThrow(/entre 0.5 e 30/);
    await expect(settings.saveSettings({ maxExecutionMinutes: 45 })).rejects.toThrow();
  });
});
