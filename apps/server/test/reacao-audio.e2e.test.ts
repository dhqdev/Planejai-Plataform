import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Áudio: a reação automática sai pelo assunto do que foi falado (depois da transcrição), não com um fone fixo. */
const enabled = Boolean(process.env.TEST_DATABASE_URL);

let server: http.Server;
const completion = (content: string) => ({
  model: "fake/model",
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.000001 },
});

describe.skipIf(!enabled)("reação de áudio pelo assunto (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let channels: typeof import("../src/channels/index.js");
  let conv: string;

  beforeAll(async () => {
    server = http
      .createServer((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
          const body = JSON.parse(b);
          const hasAudio = JSON.stringify(body.messages).includes("input_audio");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(completion(hasAudio ? "hoje fui no cinema ver um filme novo" : "Que legal!")));
        });
      })
      .listen(4599);
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    channels = await import("../src/channels/index.js");
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    const u = await upsertUser("5519911113333", "Ana");
    await db.query("UPDATE users SET status = 'active' WHERE id = $1", [u.id]);
    conv = (await upsertConversation(u.id, "playground", "jid-ana-audio")).id;
  });

  afterAll(async () => {
    server?.close();
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  it("reage com o emoji do tema do áudio", async () => {
    await db.query("INSERT INTO messages (conversation_id, role, content, external_id, media, meta) VALUES ($1, 'user', '', 'aud1', $2, $3)", [
      conv,
      { base64: Buffer.from("fake-ogg").toString("base64"), mimetype: "audio/ogg; codecs=opus" },
      { kind: "audio" },
    ]);
    const channel = new channels.PlaygroundChannel();
    const { processConversation } = await import("../src/agent/orchestrator.js");
    await processConversation(conv, { trigger: "message", channel });
    const reactions = channel.sent.filter((s) => s.type === "reaction").map((s) => s.emoji);
    expect(reactions[0]).toBe("🍿");
    expect(reactions).not.toContain("🎧");
  });
});
