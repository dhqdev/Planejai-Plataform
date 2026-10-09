import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Mensagem avulsa (send_whatsapp): "manda pro cliente a proposta amanhã às 8h". Sai como mensagem normal,
 * sem convite de cadastro, só depois do "sim"; a resposta de quem recebeu volta para quem mandou.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const TZ = "America/Sao_Paulo";
const CLIENT = "5511977776666";

let server: http.Server;
let seq = 0;
const call = (name: string, args: unknown) => ({ id: `d${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const completion = (content: string | null, tool_calls?: unknown[]) => ({
  model: "fake/model",
  choices: [{ message: { role: "assistant", content, tool_calls }, finish_reason: tool_calls ? "tool_calls" : "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.000001 },
});

function fakeOpenRouter(body: any) {
  const last = body.messages.at(-1);
  const userText = String(body.messages.findLast((m: any) => m.role === "user")?.content ?? "");
  if (last.role === "tool") return completion(String(last.content).includes("confirm") ? "Posso mandar para o Rafael?" : "Pronto!");
  if (userText.includes("proposta")) {
    return completion(null, [call("send_whatsapp", { phone: "(11) 97777-6666", name: "Rafael", message: "Bom dia, Rafael! Aqui é o David, segue a proposta que combinamos." })]);
  }
  return completion("ok");
}

describe.skipIf(!enabled)("mensagem avulsa para qualquer número (e2e)", () => {
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
    conv = (await upsertConversation(david.id, "playground", "jid-david-direct")).id;
  });

  afterAll(async () => {
    server?.close();
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  const sentTexts = () => channels.playground.sent.filter((s) => s.type === "text").map((s) => s.text!);

  async function say(text: string) {
    await db.query("INSERT INTO messages (conversation_id, role, content, external_id, meta) VALUES ($1, 'user', $2, $3, $4)", [conv, text, `d${++seq}`, { kind: "text" }]);
    const channel = new channels.PlaygroundChannel();
    await mod.processConversation(conv, { trigger: "message", channel });
    return channel.sent.filter((s) => s.type === "text").map((s) => s.text!);
  }

  it("só manda depois do sim, sem convite, e a resposta volta para quem mandou", async () => {
    const before = sentTexts().length;
    await say("manda a proposta pro Rafael, 11 97777-6666");
    expect(sentTexts().length).toBe(before);
    expect(await db.one("SELECT tool FROM pending_actions WHERE conversation_id = $1 AND status = 'pending'", [conv])).toMatchObject({ tool: "send_whatsapp" });

    await say("sim");
    const d = await db.one("SELECT * FROM direct_messages WHERE user_id = $1", [david.id]);
    expect(d).toMatchObject({ phone: CLIENT, name: "Rafael", status: "sent" });
    const out = sentTexts().slice(before);
    // texto dela, como está (já diz quem manda), e nada de convite
    expect(out).toContain("Bom dia, Rafael! Aqui é o David, segue a proposta que combinamos.");
    expect(out.join("\n")).not.toMatch(/convid|Planejai\*|Responda \*SIM\*/);
    expect(await db.one("SELECT COUNT(*)::int AS n FROM invites")).toEqual({ n: 0 });

    const { ingest } = await import("../src/ingest.js");
    const r = await ingest({ channel: "playground", remoteJid: `${CLIENT}@s.whatsapp.net`, phone: CLIENT, externalId: `c${++seq}`, kind: "text", text: "Recebi, obrigado!", timestamp: new Date(), raw: {} });
    expect(r.reason).toBe("resposta de mensagem avulsa");
    expect(await db.one("SELECT id FROM users WHERE phone = $1", [CLIENT])).toBeUndefined();
    expect(sentTexts().at(-1)).toMatch(/\*Rafael\* respondeu:\s+Recebi, obrigado!/);

    // a conversa aparece na tela Recados, em Pessoas, com a resposta dele por último
    const { listContactChats } = await import("../src/direct.js");
    const chat = (await listContactChats(david.id)).find((c) => c.phone === CLIENT)!;
    expect(chat).toMatchObject({ name: "Rafael", member: false, waiting_you: true });
    expect(chat.log.map((l) => l.from)).toEqual(["nos", "eles"]);
    expect(chat.log[1]!.text).toBe("Recebi, obrigado!");
  });

  it("agenda para depois, avisa quando sai e dá para cancelar", async () => {
    const { createDirect, sendDirect, listDirect, cancelDirect, directText } = await import("../src/direct.js");
    const u = { id: david.id, phone: david.phone, name: "David" };
    // sem o nome de quem manda, o servidor apresenta
    expect(directText("segue o cardápio do evento", u)).toMatch(/^Oi! Aqui é o assistente virtual de David\. Segue o cardápio/);

    const at = new Date(Date.now() + 15 * 3600_000);
    const r: any = await createDirect({ user: u, phone: "11 96666-5555", name: "Restaurante", message: "Oi, aqui é o David, confirmo a mesa para 4 amanhã.", sendAt: at, timezone: TZ });
    expect(r.ok).toBe(true);
    expect(r.scheduled_for).toBeTruthy();
    expect((await listDirect(david.id)).map((d) => d.id)).toContain(r.id);
    const job = await db.one("SELECT name, start_after FROM pgboss.job WHERE data->>'directId' = $1", [r.id]);
    expect(job.name).toBe("outbound.send");
    expect(Math.abs(new Date(job.start_after).getTime() - at.getTime())).toBeLessThan(2000);

    // quando vence: sai e avisa a pessoa
    const { runOutboundJob } = await import("../src/api/routes/internal.js");
    await runOutboundJob({ type: "direct", directId: r.id });
    expect(sentTexts()).toContain("Oi, aqui é o David, confirmo a mesa para 4 amanhã.");
    expect(sentTexts().at(-1)).toMatch(/Mandei para Restaurante/);
    expect(((await sendDirect(r.id)) as any).ok).toBe(false); // não manda duas vezes

    const r2: any = await createDirect({ user: u, phone: "11 96666-5555", message: "Oi, aqui é o David", sendAt: at, timezone: TZ });
    expect(await cancelDirect(david.id, r2.id)).toEqual({ ok: true });
    await runOutboundJob({ type: "direct", directId: r2.id });
    expect(await db.one("SELECT status FROM direct_messages WHERE id = $1", [r2.id])).toEqual({ status: "cancelled" });

    // o próprio número não
    expect(((await createDirect({ user: u, phone: david.phone, message: "oi", timezone: TZ })) as any).ok).toBe(false);
  });
});
