import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Recursos do WhatsApp embutido além de texto e mídia: convite de evento no compromisso, pino de localização,
 * cartão de contato, [[fixar]], apagar mensagem nossa, "ainda tô nisso" editando o aviso e fotos seguidas em álbum.
 * Canal falso com os mesmos métodos do Baileys; o OpenRouter é um servidor falso como no agent.e2e.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe("cartões nativos e [[fixar]]", () => {
  it("monta evento, localização e contato no formato do Baileys", async () => {
    await import("../src/channels/index.js");
    const { cardContent } = await import("../src/channels/baileys.js");
    const ev: any = cardContent({ kind: "event", event: { name: "Dentista", start: "2026-10-20T18:00:00.000Z", location: "Rua A, 10" } });
    expect(ev.event.name).toBe("Dentista");
    expect(ev.event.startDate.toISOString()).toBe("2026-10-20T18:00:00.000Z");
    expect(ev.event.location).toEqual({ name: "Rua A, 10" });
    const loc: any = cardContent({ kind: "location", location: { lat: -22.9, lng: -47.06, name: "Parque" } });
    expect(loc.location).toMatchObject({ degreesLatitude: -22.9, degreesLongitude: -47.06, name: "Parque" });
    const c: any = cardContent({ kind: "contact", contact: { name: "Ana;\nSilva", phone: "+55 (19) 99999-0000" } });
    expect(c.contacts.contacts[0].vcard).toContain("waid=5519999990000:+5519999990000");
    expect(c.contacts.displayName).toBe("Ana  Silva");
    expect(cardContent({ kind: "image", base64: "x" })).toBeNull();
  });

  it("[[fixar]] marca o balão e some do texto", async () => {
    const { splitBubbles } = await import("../src/agent/orchestrator.js");
    expect(splitBubbles("[[fixar]] 🛒 Lista: arroz e feijão\n---\nQuer mais algo?")).toEqual([
      { type: "text", text: "🛒 Lista: arroz e feijão", pin: true },
      { type: "text", text: "Quer mais algo?" },
    ]);
  });
});

let server: http.Server;
let seq = 0;
const call = (name: string, args: unknown) => ({ id: `c${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const completion = (content: string | null, tool_calls?: unknown[]) => ({
  model: "fake/model",
  choices: [{ message: { role: "assistant", content, tool_calls }, finish_reason: tool_calls ? "tool_calls" : "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.000001 },
});

/** compromisso daqui a 3 dias às 15h (hora local da stack) */
const future = (() => {
  const d = new Date(Date.now() + 3 * 86_400_000);
  return `${d.toISOString().slice(0, 10)}T15:00`;
})();

function fakeOpenRouter(body: any) {
  const last = body.messages.at(-1);
  const userText = String(body.messages.findLast((m: any) => m.role === "user")?.content ?? "");
  const lastTool = last.role === "tool" ? JSON.parse(last.content) : null;
  const tools = (body.tools ?? []).map((t: any) => t.function.name);
  if (userText.includes("lista do mercado")) return completion("[[fixar]] 🛒 Lista do mercado: arroz, feijão e café");
  if (userText.includes("dentista")) {
    if (lastTool) return completion("Marcado ✅");
    return completion(null, [call("schedule_reminder", { intent: "dentista", title: "Dentista", event_at: future, before_minutes: 60 })]);
  }
  if (userText.includes("onde fica o parque")) {
    if (lastTool) return completion(`Fica aqui 👇\n[[media:${lastTool.media_id}]]`);
    return completion(null, [call("send_location", { name: "Parque Taquaral", lat: -22.875, lng: -47.05 })]);
  }
  if (userText.includes("número da Ana")) {
    if (lastTool) return completion(`Aqui 👇\n[[media:${lastTool.media_id}]]`);
    return completion(null, [call("send_contact_card", { name: "Ana", phone: "19999990000" })]);
  }
  if (userText.includes("apaga isso")) {
    if (lastTool) return completion(lastTool.ok ? "Apaguei 👍" : "Não consegui apagar");
    expect(tools).toContain("unsend_message");
    return completion(null, [call("unsend_message", {})]);
  }
  return completion("[[silencio]]");
}

describe.skipIf(!enabled)("WhatsApp: cartões, fixar, apagar e álbum (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let mod: typeof import("../src/agent/orchestrator.js");
  let channels: typeof import("../src/channels/index.js");
  let convId: string;
  let Rich: any;

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
    Rich = class extends channels.PlaygroundChannel {
      rich = true;
      log: string[] = [];
      async sendText(to: string, text: string) {
        await super.sendText(to, text);
        return { id: `id-${this.sent.length}` };
      }
      async sendImage(to: string, image: any) {
        await super.sendImage(to, image);
        return { id: `id-${this.sent.length}` };
      }
      async editText(_to: string, id: string, text: string) {
        this.log.push(`edit ${id} ${text}`);
      }
      async deleteMessage(_to: string, id: string) {
        this.log.push(`delete ${id}`);
      }
      async pinMessage(_to: string, id: string, days: number) {
        this.log.push(`pin ${id} ${days}`);
      }
      async sendAlbum(_to: string, items: any[]) {
        this.log.push(`album ${items.length}`);
        return { ids: items.map((_, i) => `al-${i}`) };
      }
    };
  });

  afterAll(async () => {
    server?.close();
    await (await import("../src/queue/boss.js")).stopBoss().catch(() => {});
  });

  const say = async (text: string, channel: any) => {
    await db.query("INSERT INTO messages (conversation_id, role, content, external_id) VALUES ($1, 'user', $2, $3)", [convId, text, `in-${++seq}`]);
    return mod.processConversation(convId, { trigger: "playground", channel });
  };

  it("[[fixar]] manda a lista e fixa por 7 dias", async () => {
    const ch = new Rich();
    await say("me manda a lista do mercado", ch);
    const text = ch.sent.find((s: any) => s.type === "text");
    expect(text.text).toBe("🛒 Lista do mercado: arroz, feijão e café");
    expect(ch.log).toContain(`pin id-${ch.sent.indexOf(text) + 1} 7`);
  });

  it("compromisso com hora leva o convite de evento; no canal sem cartão, nada a mais", async () => {
    const ch = new Rich();
    await say("marquei o dentista", ch);
    const card = ch.sent.find((s: any) => s.type === "image" && s.image.kind === "event");
    expect(card.image.event.name).toBe("Dentista");
    expect(new Date(card.image.event.start).getTime()).toBeGreaterThan(Date.now());
    const plain = new channels.PlaygroundChannel();
    await say("e o dentista de novo", plain);
    expect(plain.sent.some((s: any) => s.type === "image")).toBe(false);
  });

  it("localização e contato viram cartão no WhatsApp e texto com link nos outros canais", async () => {
    const ch = new Rich();
    await say("onde fica o parque?", ch);
    expect(ch.sent.find((s: any) => s.type === "image").image).toMatchObject({ kind: "location", location: { lat: -22.875, lng: -47.05 } });
    await say("me passa o número da Ana", ch);
    expect(ch.sent.findLast((s: any) => s.type === "image").image).toMatchObject({ kind: "contact", contact: { phone: "5519999990000" } });
    const plain = new channels.PlaygroundChannel();
    await say("onde fica o parque?", plain);
    expect(plain.sent.map((s: any) => s.text).join("\n")).toContain("https://www.google.com/maps/search/?api=1&query=-22.875,-47.05");
    expect(plain.sent.some((s: any) => s.type === "image")).toBe(false);
  });

  it("apaga isso: apaga a última mensagem do assistente", async () => {
    const ch = new Rich();
    await say("me manda a lista do mercado", ch);
    const sentId = `id-${ch.sent.findIndex((s: any) => s.type === "text") + 1}`;
    const ch2 = new Rich();
    await say("apaga isso", ch2);
    expect(ch2.log).toContain(`delete ${sentId}`);
    expect(ch2.sent.find((s: any) => s.type === "text").text).toBe("Apaguei 👍");
  });

  it("fotos seguidas saem num álbum; foto com legenda fica sozinha", async () => {
    const { Outbox } = await import("../src/agent/tools/types.js");
    const { Tracer } = await import("../src/agent/trace.js");
    const ch = new Rich();
    const outbox = new Outbox();
    const a = outbox.addMedia({ base64: "YQ==", mimetype: "image/png" });
    const b = outbox.addMedia({ base64: "Yg==", mimetype: "image/png" });
    const c = outbox.addMedia({ base64: "Yw==", mimetype: "image/png", caption: "legenda" });
    const conversation = await db.one("SELECT * FROM conversations WHERE id = $1", [convId]);
    const tracer = await Tracer.start({ trigger: "playground", input: "álbum" });
    await mod.deliver(
      [
        { type: "media", id: a },
        { type: "media", id: b },
        { type: "media", id: c },
      ],
      { channel: ch, conversation, outbox, tracer, keepInDb: false },
    );
    expect(ch.log).toEqual(["album 2"]);
    expect(ch.sent.map((s: any) => s.image?.caption)).toEqual(["legenda"]);
  });

  it("primeira conversa no WhatsApp: pede para salvar o número com o cartão e salva a pessoa, uma vez só", async () => {
    const { introduceOnce, SAVE_ME_TEXT } = await import("../src/wa-save.js");
    const { upsertUser } = await import("../src/ingest.js");
    await db.query("UPDATE wa_sessions SET phone = '5519988887777', name = 'Planejai' WHERE id = 'default'");
    const u = await upsertUser("5519911112222", "Carla Souza");
    const ch = new Rich();
    ch.id = "baileys";
    const saved: unknown[] = [];
    ch.saveContact = async (...a: unknown[]) => void saved.push(a);
    const conv = { remote_jid: "123456@lid" };
    expect(await introduceOnce(ch, conv, u)).toBe(true);
    expect(ch.sent.find((s: any) => s.type === "text").text).toBe(SAVE_ME_TEXT);
    expect(ch.sent.find((s: any) => s.type === "image").image).toMatchObject({ kind: "contact", contact: { name: "Planejai", phone: "5519988887777" } });
    expect(saved).toEqual([["5519911112222", "Carla Souza", "123456@lid"]]);
    expect(await introduceOnce(ch, conv, u)).toBe(false);
    expect(ch.sent.length).toBe(2);
    // fora do WhatsApp embutido não faz nada
    const u2 = await upsertUser("5519933334444", "Rui");
    expect(await introduceOnce(new Rich(), { remote_jid: "5519933334444@s.whatsapp.net" }, u2)).toBe(false);
  });

  it("o \"ainda tô nisso\" edita o aviso de antes em vez de mandar outro balão", async () => {
    const { Progress } = await import("../src/agent/progress.js");
    const { Tracer } = await import("../src/agent/trace.js");
    const ch = new Rich();
    const p = new Progress({ channel: ch, jid: "teste", tracer: await Tracer.start({ trigger: "playground", input: "aviso" }) });
    await p.say("Deixa eu ver isso aqui rapidinho 🔎", "reserva");
    await p.say("Ainda tô nisso, só mais um pouquinho ⏳", "reserva");
    p.stop();
    expect(ch.sent.filter((s: any) => s.type === "text").length).toBe(1);
    expect(ch.log).toEqual(["edit id-1 Ainda tô nisso, só mais um pouquinho ⏳"]);
  });
});
