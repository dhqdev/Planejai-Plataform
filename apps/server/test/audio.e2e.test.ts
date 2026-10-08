import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { oggSeconds, speakable, splitForSpeech, ttsCost } from "../src/agent/tts.js";

/** Mensagem de voz: o CTO escreve o texto, a rota "tts" (OpenRouter falso) fala e o ffmpeg vira Ogg/Opus. */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
let hasFfmpeg = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  hasFfmpeg = false;
}

describe("voz (sem banco)", () => {
  it("limpa o texto e corta em fim de frase", () => {
    expect(speakable("*Era uma vez* 🐉 um dragão. Veja https://x.com/a [[media:m1]]")).toBe("Era uma vez um dragão. Veja");
    const parts = splitForSpeech("Frase um. ".repeat(300), 1200);
    expect(parts.every((p) => p.length <= 1200 && p.endsWith("."))).toBe(true);
    expect(parts.join(" ").length).toBe("Frase um. ".repeat(300).trim().length);
  });
  it("custo por caractere, por segundo ou por token", () => {
    expect(ttsCost({ prompt: 0.62e-6, completion: 0 }, 1000, 60)).toBeCloseTo(0.00062, 8);
    expect(ttsCost({ prompt: 0, completion: 0.0025 }, 1000, 10)).toBeCloseTo(0.025, 8);
    expect(ttsCost({ prompt: 0.5e-6, completion: 6e-6 }, 400, 10)).toBeCloseTo(100 * 0.5e-6 + 250 * 6e-6, 10);
  });
});

describe.skipIf(!enabled || !hasFfmpeg)("voz (e2e)", () => {
  let server: http.Server;
  let mp3: Buffer;
  const speechCalls: any[] = [];
  let db: typeof import("../src/db/pool.js");

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "pj-tts-test-"));
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ac", "1", "-b:a", "32k", join(dir, "s.mp3")]);
    mp3 = readFileSync(join(dir, "s.mp3"));
    rmSync(dir, { recursive: true, force: true });
    let n = 0;
    server = http
      .createServer((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
          if (req.url?.startsWith("/models")) {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify({ data: [{ id: "hexgrad/kokoro-82m", pricing: { prompt: "0.00000062", completion: "0" } }] }));
          }
          if (req.url === "/audio/speech") {
            speechCalls.push(JSON.parse(b));
            res.writeHead(200, { "content-type": "audio/mpeg" });
            return res.end(mp3);
          }
          const body = JSON.parse(b);
          const last = body.messages.at(-1);
          const msg =
            last.role === "tool"
              ? { role: "assistant", content: `[[media:${JSON.parse(last.content).media_id}]]` }
              : { role: "assistant", content: null, tool_calls: [{ id: `a${++n}`, type: "function", function: { name: "make_audio", arguments: JSON.stringify({ text: "*Era uma vez* um dragão que gostava de dormir. Fim. 🐉" }) } }] };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ model: "fake/model", choices: [{ message: msg, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.000001 } }));
        });
      })
      .listen(4599);
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
  });

  afterAll(async () => {
    server?.close();
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  it("pediu em áudio: sai mensagem de voz Ogg/Opus e o custo entra na execução", async () => {
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    const user = await upsertUser("5519922222222", "Bia");
    await db.query("UPDATE users SET status = 'active' WHERE id = $1", [user.id]);
    const convId = (await upsertConversation(user.id, "playground", "teste-voz")).id;
    await db.query("INSERT INTO messages (conversation_id, role, content, external_id) VALUES ($1, 'user', 'me conta uma história curta em áudio', 'v1')", [convId]);
    const { PlaygroundChannel } = await import("../src/channels/index.js");
    const channel = new PlaygroundChannel();
    const r = await (await import("../src/agent/orchestrator.js")).processConversation(convId, { trigger: "playground", channel });

    expect(speechCalls).toEqual([{ model: "hexgrad/kokoro-82m", input: "Era uma vez um dragão que gostava de dormir. Fim.", response_format: "mp3", voice: "pf_dora" }]);
    const sent = channel.sent.filter((s) => s.type === "image");
    expect(sent).toHaveLength(1);
    const audio = sent[0]!.image!;
    expect(audio.kind).toBe("audio");
    expect(audio.ptt).toBe(true);
    expect(audio.mimetype).toBe("audio/ogg; codecs=opus");
    const ogg = Buffer.from(audio.base64!, "base64");
    expect(ogg.subarray(0, 4).toString()).toBe("OggS");
    expect(oggSeconds(ogg)).toBe(3);
    expect(channel.sent.some((s) => s.type === "text")).toBe(false);

    const step = await db.one("SELECT cost_usd FROM execution_steps WHERE execution_id = $1 AND name = 'make_audio'", [r.executionId]);
    expect(Number(step.cost_usd)).toBeCloseTo(48 * 0.62e-6, 6); // numeric(12,6)
    const sendStep = await db.one("SELECT status FROM execution_steps WHERE execution_id = $1 AND name = 'enviar_audio'", [r.executionId]);
    expect(sendStep.status).toBe("success");
  });
});
