import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Conversa delegada: "a Maria tá passando mal, conversa com ela" (Postgres real + OpenRouter falso).
 * Só começa depois do sim; quem fala é o agente escolhido (Saúde); a Maria não fica no vácuo; sinal de urgência
 * avisa o dono na hora, sem IA; o fim manda resumo. E quem chega de fora sem ninguém pedir recebe só a mensagem fixa.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const TZ = "America/Sao_Paulo";
const MARIA = "5519944445555";
const STRANGER = "5519955556666";

let server: http.Server;
let seq = 0;
const call = (name: string, args: unknown) => ({ id: `c${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const completion = (content: string | null, tool_calls?: unknown[]) => ({
  model: "fake/model",
  choices: [{ message: { role: "assistant", content, tool_calls }, finish_reason: tool_calls ? "tool_calls" : "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.000001 },
});
const prompts: string[] = [];

function fakeOpenRouter(body: any) {
  const system: string = body.messages[0].content;
  const last = body.messages.at(-1);
  const userText = String(body.messages.findLast((m: any) => m.role === "user")?.content ?? "");
  if (system.includes("do time do assistente virtual de David")) {
    prompts.push(system);
    if (last.role === "tool") return completion("aguardando");
    if (userText.includes("Maria: Obrigada, já melhorei")) {
      return completion(null, [
        call("errand_reply", { message: "Que bom, Maria! Fica bem e qualquer coisa me chama. 💜" }),
        call("conversa_end", { summary: "Maria teve dor de cabeça e enjoo, descansou, tomou água e melhorou." }),
      ]);
    }
    if (userText.includes("Maria: Tô com muita dor no peito")) {
      return completion(null, [
        call("errand_reply", { message: "Maria, liga agora para o SAMU, 192. Se tiver alguém perto, pede ajuda." }),
        call("conversa_alert", { reason: "Maria relatou dor forte no peito" }),
      ]);
    }
    if (userText.includes("Maria:")) return completion(null, [call("errand_reply", { message: "Entendi, Maria. Desde quando você está assim? Tá sozinha em casa?" })]);
    return completion("aguardando");
  }
  if (system.includes("CTO de um time")) {
    if (userText.includes("terminou. Resumo:")) return completion("A Cida conversou com a Maria: ela melhorou 💜");
    if (last.role === "tool") return completion("Posso pôr a Enfermeira Cida para conversar com a Maria?");
    if (userText.includes("passando mal")) {
      return completion(null, [
        call("conversa_start", {
          name: "Maria",
          phone: "(19) 94444-5555",
          message: "Oi, Maria! Aqui é a Enfermeira Cida, do time do David 😊 Ele me pediu pra falar com você. Como você está se sentindo?",
          goal: "Maria está passando mal (dor de cabeça e enjoo). Acolher e orientar.",
          agent: "saude",
        }),
      ]);
    }
    return completion("ok");
  }
  return completion("?");
}

describe.skipIf(!enabled)("conversa delegada e quem chega de fora (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let channels: typeof import("../src/channels/index.js");
  let mod: typeof import("../src/agent/orchestrator.js");
  let david: any;
  let conv: string;

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
    channels = await import("../src/channels/index.js");
    mod = await import("../src/agent/orchestrator.js");
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    david = await upsertUser("5519911112222", "David");
    await db.query("UPDATE users SET status = 'active', timezone = $2 WHERE id = $1", [david.id, TZ]);
    conv = (await upsertConversation(david.id, "playground", "jid-david-conversa")).id;
  });

  afterAll(async () => {
    server?.close();
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  const sentTexts = () => channels.playground.sent.filter((s) => s.type === "text").map((s) => s.text!);

  async function say(text: string) {
    await db.query("INSERT INTO messages (conversation_id, role, content, external_id, meta) VALUES ($1, 'user', $2, $3, $4)", [conv, text, `c${++seq}`, { kind: "text" }]);
    const channel = new channels.PlaygroundChannel();
    await mod.processConversation(conv, { trigger: "message", channel });
    return channel.sent.filter((s) => s.type === "text").map((s) => s.text!);
  }

  const from = async (phone: string, text: string) => {
    const { ingest } = await import("../src/ingest.js");
    return ingest({ channel: "playground", remoteJid: `${phone}@s.whatsapp.net`, phone, externalId: `in${++seq}`, kind: "text", text, timestamp: new Date(), raw: {} });
  };

  it("só começa depois do sim e quem fala é a Saúde, apresentada como assistente do David", async () => {
    const out = await say("a Maria tá passando mal, conversa com ela pra mim? 19 94444-5555");
    expect(out.join(" ")).toMatch(/Posso pôr a Enfermeira Cida/);
    expect(await db.one("SELECT COUNT(*)::int AS n FROM errands")).toEqual({ n: 0 });
    await say("sim");
    const e = await db.one("SELECT * FROM errands WHERE user_id = $1", [david.id]);
    expect(e).toMatchObject({ kind: "conversa", agent: "saude", place: "Maria", phone: MARIA, status: "waiting" });
    const first = sentTexts().find((t) => t.includes("Como você está se sentindo"))!;
    // a apresentação do modelo sai e entra a padrão, uma vez só, dizendo que é assistente virtual
    expect(first).toMatch(/^Oi, Maria, (bom dia|boa tarde|boa noite)! Tudo bem\? Aqui é Enfermeira Cida, assistente virtual de David\. Ele me pediu/);
    expect(first.match(/Cida/g)?.length).toBe(1);
    // sem chamada de IA para conferir: é pedido do próprio dono, com o sim
    expect(await db.one("SELECT COUNT(*)::int AS n FROM execution_steps WHERE name LIKE 'trava%'")).toEqual({ n: 0 });
  });

  it("a Maria não fica no vácuo e não vira cliente", async () => {
    const e = await db.one("SELECT id FROM errands WHERE user_id = $1", [david.id]);
    expect(await from(MARIA, "Tô com dor de cabeça e enjoo")).toEqual({ queued: false, reason: "recado" });
    expect(await db.one("SELECT id FROM users WHERE phone = $1", [MARIA])).toBeUndefined();
    const { runErrandTurn } = await import("../src/agent/errand-agent.js");
    await runErrandTurn(e.id);
    expect(sentTexts().at(-1)).toMatch(/Desde quando você está assim/);
    // prompt de saúde: sem diagnóstico nem remédio, SAMU na gravidade
    expect(prompts.at(-1)).toMatch(/Nunca diagnostique/);
    expect(prompts.at(-1)).toMatch(/SAMU \(192\)/);
  });

  it("sinal de urgência avisa o David na hora, sem IA, e a conversa continua", async () => {
    const e = await db.one("SELECT id FROM errands WHERE user_id = $1", [david.id]);
    const before = sentTexts().length;
    await from(MARIA, "Tô com muita dor no peito agora");
    // o aviso saiu no ingest, antes de qualquer chamada do modelo
    const alert = sentTexts().slice(before).find((t) => t.includes("Atenção com Maria"));
    expect(alert).toMatch(/dor no peito/);
    expect(alert).toMatch(/\+5519944445555/);
    const { runErrandTurn } = await import("../src/agent/errand-agent.js");
    await runErrandTurn(e.id);
    expect(sentTexts().at(-1)).toMatch(/SAMU, 192/);
    // o conversa_alert do agente logo depois não manda um segundo aviso (no máximo um a cada 10 min)
    expect(sentTexts().slice(before).filter((t) => t.includes("Atenção com Maria")).length).toBe(1);
    expect((await db.one("SELECT status FROM errands WHERE id = $1", [e.id])).status).toBe("waiting");
  });

  it("encerra com resumo para o David", async () => {
    const e = await db.one("SELECT id FROM errands WHERE user_id = $1", [david.id]);
    await from(MARIA, "Obrigada, já melhorei");
    const { runErrandTurn } = await import("../src/agent/errand-agent.js");
    expect((await runErrandTurn(e.id))?.kind).toBe("done");
    expect(await db.one("SELECT status, outcome FROM errands WHERE id = $1", [e.id])).toMatchObject({ status: "done", outcome: expect.stringMatching(/melhorou/) });
    expect(sentTexts().at(-1)).toMatch(/A Cida conversou com a Maria/);
    // depois de encerrada, a Maria (com quem o David pediu para falar) não recebe a propaganda de assinatura
    expect((await from(MARIA, "Valeu!")).reason).toBe("contato pending");
  });

  it("limite de mensagens é maior que o do recado", async () => {
    const { MAX_CONVERSA_MESSAGES, MAX_ERRAND_MESSAGES, messageLimit } = await import("../src/errands.js");
    expect(messageLimit({ kind: "conversa" })).toBe(MAX_CONVERSA_MESSAGES);
    expect(messageLimit({ kind: "recado" })).toBe(MAX_ERRAND_MESSAGES);
    expect(MAX_CONVERSA_MESSAGES).toBeGreaterThan(MAX_ERRAND_MESSAGES);
  });

  it("quem chega de fora sem ninguém pedir recebe só a mensagem fixa, uma vez por semana", async () => {
    const before = sentTexts().length;
    expect(await from(STRANGER, "oi, quem é?")).toEqual({ queued: false, reason: "convite para assinar" });
    const got = sentTexts();
    expect(got.at(-1)).toMatch(/assinar/);
    expect(got.at(-1)).toMatch(/https?:\/\//);
    // segunda mensagem na mesma semana: silêncio, e nada de IA
    expect((await from(STRANGER, "oi??")).reason).toBe("contato pending");
    expect(sentTexts().length).toBe(before + 1);
    expect(await db.one("SELECT COUNT(*)::int AS n FROM executions WHERE input LIKE '%quem é%'")).toEqual({ n: 0 });
    // texto próprio do dono em Configurações
    const { strangerText } = await import("../src/outreach.js");
    expect(strangerText("  Assine em planejai.tekvosoft.com  ")).toBe("Assine em planejai.tekvosoft.com");
  });
});
