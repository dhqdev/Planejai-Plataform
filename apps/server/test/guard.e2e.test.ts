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
  if (body.messages.some((m: any) => m.role === "system" && String(m.content).startsWith("Em paralelo"))) return completion("paralelo ok");
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
    const m = await db.one("INSERT INTO messages (conversation_id, role, content, external_id) VALUES ($1, 'user', $2, $3) RETURNING conversation_id", [convId, text, `e${++seq}`]);
    // o ingest conta o uso do dia (as mensagens em si não ficam no banco)
    await db.query(
      `INSERT INTO usage_daily (user_id, day, messages) SELECT user_id, current_date, 1 FROM conversations WHERE id = $1
       ON CONFLICT (user_id, day) DO UPDATE SET messages = usage_daily.messages + 1`,
      [m.conversation_id],
    );
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
    // respondeu, mas pela metade: em Execuções aparece "Parcial" com o motivo, não "Sucesso"
    const exec = await db.one("SELECT status, error FROM executions WHERE id = $1", [r.executionId]);
    expect(exec.status).toBe("partial");
    expect(exec.error).toMatch(/tempo máximo/);
    await settings.saveSettings({ maxExecutionMinutes: 8 });
  });

  it("execução que morreu com o processo não fica 'rodando' para sempre", async () => {
    const old = await db.one("INSERT INTO executions (trigger, started_at) VALUES ('message', now() - interval '1 hour') RETURNING id");
    const fresh = await db.one("INSERT INTO executions (trigger) VALUES ('message') RETURNING id");
    await db.query("INSERT INTO execution_steps (execution_id, agent, type, name) VALUES ($1, 'cto', 'llm', 'x')", [old.id]);
    const { closeOrphanRuns } = await import("../src/maintenance.js");
    await closeOrphanRuns();
    const rows = await db.many("SELECT id, status, error FROM executions WHERE id = ANY($1)", [[old.id, fresh.id]]);
    expect(rows.find((x) => x.id === old.id)).toMatchObject({ status: "error", error: expect.stringMatching(/reiniciou/) });
    expect(rows.find((x) => x.id === fresh.id)?.status).toBe("running");
    expect((await db.one("SELECT status FROM execution_steps WHERE execution_id = $1", [old.id])).status).toBe("error");
    await db.query("DELETE FROM executions WHERE id = ANY($1)", [[old.id, fresh.id]]);
  });

  it("limite de ações corta o loop de ferramentas e o time responde com o que tem", async () => {
    await settings.saveSettings({ maxToolCalls: 5 });
    const { convId } = await newConversation("5511900000102");
    const { r, texts } = await say(convId, "LOOP");
    expect(texts).toEqual(["parei no limite"]);
    const tools = await db.many("SELECT status FROM execution_steps WHERE execution_id = $1 AND type = 'tool'", [r.executionId]);
    expect(tools.filter((t) => t.status === "success").length).toBe(5);
    expect((await db.one("SELECT status FROM executions WHERE id = $1", [r.executionId])).status).toBe("partial");
    await settings.saveSettings({ maxToolCalls: 40 });
  });

  it("conversa com todas as vagas ocupadas não prende a vaga do worker: devolve busy na hora", async () => {
    const { convId } = await newConversation("5511900000109");
    await db.query("INSERT INTO messages (conversation_id, role, content, external_id) VALUES ($1, 'user', 'oi', $2)", [convId, `e${++seq}`]);
    const holder = await db.pool.connect();
    try {
      for (let i = 0; i < mod.PARALLEL_RUNS; i++) await holder.query("SELECT pg_advisory_lock(hashtext($1), $2)", [convId, i]);
      const r = await mod.processConversation(convId, { trigger: "message", channel: new channels.PlaygroundChannel(), wait: false });
      expect(r.busy).toBe(true);
    } finally {
      for (let i = 0; i < mod.PARALLEL_RUNS; i++) await holder.query("SELECT pg_advisory_unlock(hashtext($1), $2)", [convId, i]);
      holder.release();
    }
    const r = await mod.processConversation(convId, { trigger: "message", channel: new channels.PlaygroundChannel(), wait: false });
    expect(r.busy).toBeFalsy();
    expect(r.bubbles.length).toBeGreaterThan(0);
  });

  it("pergunta nova é respondida enquanto a anterior ainda trabalha, sem repetir a mesma mensagem", async () => {
    const { convId } = await newConversation("5511900000110");
    await db.query("INSERT INTO messages (conversation_id, role, content, external_id) VALUES ($1, 'user', 'DEMORA pesquisa longa', $2)", [convId, `e${++seq}`]);
    const slowChannel = new channels.PlaygroundChannel();
    const slow = mod.processConversation(convId, { trigger: "message", channel: slowChannel, wait: false });
    await new Promise((r) => setTimeout(r, 600));
    await db.query("INSERT INTO messages (conversation_id, role, content, external_id) VALUES ($1, 'user', 'e outra coisa?', $2)", [convId, `e${++seq}`]);
    const fastChannel = new channels.PlaygroundChannel();
    const t0 = Date.now();
    const fast = await mod.processConversation(convId, { trigger: "message", channel: fastChannel, wait: false });
    expect(fast.busy).toBeFalsy();
    expect(Date.now() - t0).toBeLessThan(2500);
    // a segunda rodada sabe que a primeira ainda está respondendo (e não refaz)
    expect(fastChannel.sent.filter((s) => s.type === "text").map((s) => s.text)).toEqual(["paralelo ok"]);
    await slow;
    expect(slowChannel.sent.filter((s) => s.type === "text").map((s) => s.text)).toEqual(["demorei"]);
    expect((await db.one("SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1 AND processed = false", [convId])).n).toBe(0);
  });

  it("botão Parar: a execução para em segundos e a pessoa recebe um aviso curto", async () => {
    const { convId } = await newConversation("5511900000111");
    await db.query("INSERT INTO messages (conversation_id, role, content, external_id) VALUES ($1, 'user', 'DEMORA muito', $2)", [convId, `e${++seq}`]);
    const channel = new channels.PlaygroundChannel();
    const t0 = Date.now();
    const run = mod.processConversation(convId, { trigger: "message", channel, wait: false });
    await new Promise((r) => setTimeout(r, 400));
    const exec = await db.one("SELECT id FROM executions WHERE conversation_id = $1 AND status = 'running'", [convId]);
    const { requestStop, stopConversationRuns, isStopCommand } = await import("../src/agent/stop.js");
    expect(await requestStop(exec.id)).toBe(true);
    const r = await run;
    expect(Date.now() - t0).toBeLessThan(3800);
    expect(channel.sent.filter((s) => s.type === "text").map((s) => s.text)).toEqual([mod.STOPPED_TEXT]);
    expect(await db.one("SELECT status, error FROM executions WHERE id = $1", [r.executionId])).toMatchObject({ status: "partial", error: "Parada a pedido" });
    // já terminou: não tem o que parar
    expect(await requestStop(exec.id)).toBe(false);
    expect(await stopConversationRuns(convId)).toBe(0);
    expect(isStopCommand("para")).toBe(true);
    expect(isStopCommand("Cancela isso!")).toBe(true);
    expect(isStopCommand("para amanhã às 9h")).toBe(false);
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
