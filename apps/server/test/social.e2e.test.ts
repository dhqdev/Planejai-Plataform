import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Convites pelo WhatsApp, contatos que mandam coisas um pro outro, cadastro por convite,
 * acompanhamentos proativos e melhoria diária dos agentes (Postgres real + OpenRouter falso).
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);

let server: http.Server;
let seq = 0;
const call = (name: string, args: unknown) => ({ id: `s${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const completion = (content: string | null, tool_calls?: unknown[]) => ({
  model: "fake/model",
  choices: [{ message: { role: "assistant", content, tool_calls }, finish_reason: tool_calls ? "tool_calls" : "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.000001 },
});

function fakeOpenRouter(body: any) {
  const first = body.messages[0];
  if (Array.isArray(first.content)) return completion("Foto de uma jaqueta jeans azul num cabide.");
  const system: string = first.content;
  const last = body.messages.at(-1);
  if (system.includes("reunião noturna")) {
    return completion(
      JSON.stringify({
        topics: [{ topic: "cinema", weight: 4 }],
        style: "Respostas curtas, com emoji de cinema. Chama ele de Davi.",
        agent_notes: [{ agent: "pesquisador", note: "Mora em Campinas, prefere o Iguatemi." }, { agent: "hacker", note: "x" }],
        tabs: { enable: ["meu_time", "admin"], custom: [{ title: "Cinema", icon: "ticket", widgets: ["reminders", "categories", "apagar"] }] },
        create: [{ topic: "cinema", name: "Cinema", persona: "Pipoca", focus: "sessões e estreias em Campinas", instructions: "Busque no ingresso.com. Ele prefere sessões depois das 19h.", tools: ["web_search", "fetch_url", "apagar_tudo"] }],
        update: [],
        retire: [],
      }),
    );
  }
  if (system.includes("avisando a pessoa")) return completion("Saiu a data do show do Coldplay em SP: 12/03. https://ex.com/coldplay");
  if (system.includes("CTO de um time")) {
    const userText = String(body.messages.findLast((m: any) => m.role === "user")?.content ?? "");
    if (last.role === "tool") return completion("Feito!");
    if (userText.includes("convida o Giovani")) return completion(null, [call("invite_person", { name: "Giovani Silva", phone: "(19) 92222-3333", confirmed_by_user: true })]);
    if (userText.includes("manda esse look")) return completion(null, [call("send_to_contact", { contact: "giovani", message: "Olha esse look, o que acha?", attach_photo: true })]);
    return completion("ok");
  }
  return completion("?");
}

describe.skipIf(!enabled)("convites, contatos e proatividade (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let channels: typeof import("../src/channels/index.js");
  let mod: typeof import("../src/agent/orchestrator.js");
  let social: typeof import("../src/social.js");
  let david: any;
  let davidConv: string;
  const realFetch = globalThis.fetch;
  let tavilyResults: { title: string; url: string; content: string }[] = [];

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
    globalThis.fetch = (async (url: any, init?: any) => {
      if (String(url).includes("api.tavily.com")) return new Response(JSON.stringify({ results: tavilyResults }), { status: 200, headers: { "content-type": "application/json" } });
      return realFetch(url, init);
    }) as typeof fetch;
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    channels = await import("../src/channels/index.js");
    mod = await import("../src/agent/orchestrator.js");
    social = await import("../src/social.js");
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    david = await upsertUser("5519911110000", "David");
    await db.query("UPDATE users SET status = 'active', full_name = 'David Queiroz' WHERE id = $1", [david.id]);
    david = await db.one("SELECT * FROM users WHERE id = $1", [david.id]);
    davidConv = (await upsertConversation(david.id, "playground", "jid-david")).id;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    server?.close();
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  const lastTexts = (n = 3) => channels.playground.sent.filter((s) => s.type === "text").slice(-n).map((s) => s.text!);

  async function say(text: string, media?: { base64: string; mimetype: string }) {
    await db.query("INSERT INTO messages (conversation_id, role, content, external_id, media, meta) VALUES ($1, 'user', $2, $3, $4, $5)", [
      davidConv,
      text,
      `d${++seq}`,
      media ?? null,
      { kind: media ? "image" : "text" },
    ]);
    const channel = new channels.PlaygroundChannel();
    await mod.processConversation(davidConv, { trigger: "message", channel });
    return channel;
  }

  it("convite sai pelo WhatsApp, a pessoa responde SIM e os dois viram contatos", async () => {
    await say("convida o Giovani, 19 92222-3333");
    // o modelo mandou confirmed_by_user=true sozinho: não vale, o pedido fica guardado esperando o "sim" da pessoa
    expect(await db.one("SELECT * FROM invites WHERE inviter_user_id = $1", [david.id])).toBeUndefined();
    expect(await db.one("SELECT tool, status FROM pending_actions WHERE conversation_id = $1", [davidConv])).toMatchObject({ tool: "invite_person", status: "pending" });
    await say("sim, pode");
    const inv = await db.one("SELECT * FROM invites WHERE inviter_user_id = $1", [david.id]);
    expect(inv).toMatchObject({ phone: "5519922223333", name: "Giovani Silva", status: "pending" });
    await social.sendInvite(inv.id);
    expect(lastTexts(1)[0]).toMatch(/David Queiroz te convidou para o \*Planejai\*[\s\S]*Responda \*SIM\*/);

    const { ingest } = await import("../src/ingest.js");
    const base = { channel: "playground", remoteJid: "jid-giovani", phone: "5519922223333", pushName: "Gio", kind: "text" as const, timestamp: new Date(), raw: null };
    // antes de responder, qualquer outra coisa recebe a instrução (sem IA)
    expect(await ingest({ ...base, externalId: "g1", text: "oi, o que é isso?" })).toEqual({ queued: false, reason: "convite" });
    expect(lastTexts(1)[0]).toContain("responda *SIM*");
    expect(await ingest({ ...base, externalId: "g2", text: "Sim!" })).toEqual({ queued: false, reason: "convite" });

    const gio = await db.one("SELECT * FROM users WHERE phone = '5519922223333'");
    expect(gio).toMatchObject({ status: "active", full_name: "Giovani Silva", invited_by: david.id });
    const contacts = await db.many("SELECT user_id FROM contacts ORDER BY user_id");
    expect(contacts.length).toBe(2);
    const texts = lastTexts(2);
    expect(texts.some((t) => t.includes("Giovani Silva aceitou seu convite"))).toBe(true);
    expect(texts.some((t) => t.startsWith("Pronto, você está no Planejai!"))).toBe(true);
    expect(await social.inviteStats(david.id)).toEqual({ total: 1, accepted: 1, pending: 0, declined: 0 });
  });

  it("'manda esse look pro Giovani' encaminha a foto com a mensagem", async () => {
    const look = { base64: Buffer.from("foto-do-look").toString("base64"), mimetype: "image/jpeg" };
    await say("manda esse look pro Giovani", look);
    const sent = channels.playground.sent.slice(-2);
    // o recado chega com a dica de como responder: a conversa é de ida e volta
    expect(sent[0]).toMatchObject({
      type: "text",
      text: "*David Queiroz* te mandou pelo Planejai:\n\nOlha esse look, o que acha?\n\n_Para responder, é só me dizer o que falar pro David._",
    });
    expect(sent[1]).toMatchObject({ type: "image", image: { base64: look.base64, mimetype: "image/jpeg" } });
    // o assistente do Giovani fica sabendo, se ele perguntar depois
    const gioConv = await db.one("SELECT c.id FROM conversations c JOIN users u ON u.id = c.user_id WHERE u.phone = '5519922223333'");
    const { recentShort } = await import("../src/shortmem.js");
    expect((await recentShort(gioConv.id, 5))?.some((e) => e.text.includes("Olha esse look"))).toBe(true);
  });

  it("cadastro no painel só com convite, e o convite conta para quem convidou", async () => {
    const { buildServer } = await import("../src/api/server.js");
    const app = await buildServer();
    const owner = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } });
    const sup = String(owner.headers["set-cookie"]).split(";")[0]!;
    const created = await app.inject({ method: "POST", url: "/api/clients", headers: { cookie: sup }, payload: { full_name: "Maria Souza", email: "maria@x.com", phone: "19 93333-4444" } });
    const link: string = created.json().link;
    const code = link.split("/").at(-1)!;
    const info = await app.inject({ method: "GET", url: `/api/invite/${code}` });
    expect(info.json()).toMatchObject({ name: "Maria Souza", email: "maria@x.com", used: false });
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { code, email: "maria@x.com", password: "senha-forte", accept_terms: true } });
    expect(reg.json()).toMatchObject({ role: "admin", pending: false });
    expect((await app.inject({ method: "GET", url: "/api/invite/NAOEXISTE" })).statusCode).toBe(404);

    const clients = (await app.inject({ method: "GET", url: "/api/clients", headers: { cookie: sup } })).json();
    const d = clients.find((c: any) => c.phone === "5519911110000");
    expect(d).toMatchObject({ invites_sent: 1, invites_accepted: 1, contacts: 1 });
    const invites = (await app.inject({ method: "GET", url: "/api/invites", headers: { cookie: sup } })).json();
    expect(invites.leaderboard[0]).toMatchObject({ name: "David Queiroz", accepted: 1 });
    await app.close();
  });

  it("acompanhamento avisa sozinho quando aparece novidade (e não gasta IA quando não há)", async () => {
    const { saveCredentials } = await import("../src/integrations/registry.js");
    await saveCredentials("tavily", { api_key: "tvly-teste" });
    const { createWatch, checkDueWatches } = await import("../src/watches.js");
    const w = await createWatch({ userId: david.id, conversationId: davidConv, kind: "news", query: "show do Coldplay em SP", notifyMode: "changes" });
    tavilyResults = [{ title: "Coldplay anuncia turnê", url: "https://ex.com/turne", content: "sem datas" }];
    const before = channels.playground.sent.length;
    expect(await checkDueWatches()).toEqual({ checked: 1, notified: 0 }); // primeira olhada só marca o que já existe
    await db.query("UPDATE watches SET next_check_at = now() WHERE id = $1", [w.id]);
    expect(await checkDueWatches()).toEqual({ checked: 1, notified: 0 }); // nada novo: nenhuma chamada de IA
    tavilyResults = [...tavilyResults, { title: "Coldplay em SP dia 12/03", url: "https://ex.com/coldplay", content: "ingressos" }];
    await db.query("UPDATE watches SET next_check_at = now() WHERE id = $1", [w.id]);
    expect(await checkDueWatches()).toEqual({ checked: 1, notified: 1 });
    expect(channels.playground.sent.length).toBe(before + 1);
    expect(lastTexts(1)[0]).toContain("Coldplay em SP: 12/03");
    const llm = await db.many("SELECT e.id FROM executions e WHERE e.trigger = 'watch'");
    expect(llm.length).toBe(1);
  });

  it("acompanhamento padrão dura 7 dias e conta cada olhada, achando ou não", async () => {
    const { createWatch, checkDueWatches, updateWatch } = await import("../src/watches.js");
    await db.query("UPDATE watches SET active = false");
    const w = await createWatch({ userId: david.id, conversationId: davidConv, kind: "news", query: "vagas de estágio em Campinas" });
    expect(Math.round((new Date(w.expires_at).getTime() - Date.now()) / 86_400_000)).toBe(7);
    tavilyResults = [{ title: "Vaga A", url: "https://ex.com/a", content: "" }];
    const before = channels.playground.sent.length;
    expect(await checkDueWatches()).toEqual({ checked: 1, notified: 1 });
    expect(lastTexts(1)[0]).toContain("Comecei a acompanhar");
    await db.query("UPDATE watches SET next_check_at = now() WHERE id = $1", [w.id]);
    expect(await checkDueWatches()).toEqual({ checked: 1, notified: 1 });
    expect(lastTexts(1)[0]).toContain("nada novo");
    expect(channels.playground.sent.length).toBe(before + 2);
    // pausado não olha; acabou o prazo: avisa uma vez e desliga
    await updateWatch(w.id, david.id, { paused: true });
    await db.query("UPDATE watches SET next_check_at = now() WHERE id = $1", [w.id]);
    expect(await checkDueWatches()).toEqual({ checked: 0, notified: 0 });
    await db.query("UPDATE watches SET expires_at = now() - interval '1 minute' WHERE id = $1", [w.id]);
    await checkDueWatches();
    expect(lastTexts(1)[0]).toContain("Terminei de acompanhar");
    const row = await db.one("SELECT active, checks FROM watches WHERE id = $1", [w.id]);
    expect(row).toEqual({ active: false, checks: 2 });
  });

  it("melhoria diária cria um agente sob medida só quando o assunto se repete", async () => {
    for (const t of ["sessões de cinema hoje em Campinas", "tem filme novo da Marvel?", "horário do cinema no Iguatemi"]) {
      await db.query("INSERT INTO executions (trigger, user_id, conversation_id, input) VALUES ('message', $1, $2, $3)", [david.id, davidConv, t]);
    }
    const { improveUser } = await import("../src/improve.js");
    // primeiro dia: só registra o assunto
    expect(await improveUser(david.id)).toEqual({ created: 0, updated: 0, retired: 0 });
    // no dia seguinte o assunto volta: agora vira agente (com só as ferramentas permitidas)
    await db.query("UPDATE user_topics SET last_at = now() - interval '1 day' WHERE user_id = $1", [david.id]);
    expect(await improveUser(david.id)).toEqual({ created: 1, updated: 0, retired: 0 });
    const agent = await db.one("SELECT slug, name, tools, persona, face IS NOT NULL AS has_face FROM client_agents WHERE user_id = $1", [david.id]);
    expect(agent).toEqual({ slug: "cinema", name: "Cinema", tools: ["web_search", "fetch_url"], persona: "Pipoca", has_face: true });
    // reunião noturna: jeito de falar, notas só de agentes que existem, abas só do catálogo
    const u = await db.one("SELECT style_notes, app_tabs FROM users WHERE id = $1", [david.id]);
    expect(u.style_notes).toContain("Davi");
    expect(u.app_tabs).toEqual({ modules: ["meu_time"], custom: [{ slug: "cinema", title: "Cinema", icon: "ticket", widgets: ["reminders", "categories"] }] });
    const notes = await db.many("SELECT agent FROM agent_notes WHERE user_id = $1", [david.id]);
    expect(notes).toEqual([{ agent: "pesquisador" }]);
    const { clientAgents } = await import("../src/agent/team.js");
    const defs = await clientAgents(david.id);
    expect(defs.map((d) => [d.id, d.task, d.tools.map((t) => t.name)])).toEqual([["c_cinema", "agent:cliente", ["web_search", "fetch_url"]]]);
  });

  it("cache de ferramentas reaproveita a mesma busca, com argumentos em qualquer ordem", async () => {
    const { toolCacheKey } = await import("../src/agent/cache.js");
    expect(toolCacheKey("web_search", { query: "Cinema", max_results: 3 })?.key).toBe(toolCacheKey("web_search", { max_results: 3, query: "cinema" })?.key);
    expect(toolCacheKey("add_transaction", { amount: 1 })).toBeNull();
  });

  it("quem já usa o Planejai não recebe o convite de novo: vira contato direto ou recebe só um pedido de contato", async () => {
    const { upsertUser, ingest } = await import("../src/ingest.js");
    const invitesBefore = (await db.one("SELECT COUNT(*)::int AS n FROM invites")).n;

    // Jonathan entrou trazido pelo David (convite antigo que não criou o contato): liga os dois na hora, sem mensagem de convite
    const jon = await upsertUser("5519955556666", "Jonathan");
    await db.query("UPDATE users SET status = 'active', invited_by = $2 WHERE id = $1", [jon.id, david.id]);
    const sentBefore = channels.playground.sent.length;
    const r = await social.createInvite({ inviterUserId: david.id, name: "Jonathan", phone: "19 95555-6666", afterAccept: "bora no cinema amanhã?" });
    expect(r).toMatchObject({ already: true, linked: true, contactId: jon.id });
    expect((await db.one("SELECT COUNT(*)::int AS n FROM invites")).n).toBe(invitesBefore);
    expect(channels.playground.sent.length).toBe(sentBefore);
    expect((await social.findContact(david.id, "jonathan")).map((c) => c.id)).toEqual([jon.id]);
    // e o Jonathan responde de volta pelo assistente dele
    expect((await social.findContact(jon.id, "david")).map((c) => c.id)).toEqual([david.id]);
    // de novo: continua sendo só "já é contato"
    expect(await social.createInvite({ inviterUserId: david.id, name: "Jonathan", phone: "19 95555-6666" })).toMatchObject({ already: true, linked: false });

    // Ana já usa o Planejai, mas não foi o David que trouxe: recebe um pedido de contato curto, com o recado guardado para o aceite
    const ana = await upsertUser("5519977778888", "Ana");
    await db.query("UPDATE users SET status = 'active' WHERE id = $1", [ana.id]);
    const req = await social.createInvite({ inviterUserId: david.id, name: "Ana", phone: "19 97777-8888", afterAccept: "bora no cinema amanhã?" });
    if ("already" in req) throw new Error("não devia virar contato sem a Ana aceitar");
    expect(req.existing).toBe(true);
    await social.sendInvite(req.invite.id);
    expect(lastTexts(1)[0]).toMatch(/^Oi, Ana! David Queiroz quer te adicionar como contato aqui no Planejai/);
    expect(lastTexts(1)[0]).not.toContain("te convidou");
    expect(await social.findContact(david.id, "ana")).toEqual([]);

    const base = { channel: "playground", remoteJid: "jid-ana", phone: "5519977778888", pushName: "Ana", kind: "text" as const, timestamp: new Date(), raw: null };
    expect(await ingest({ ...base, externalId: "a1", text: "sim" })).toEqual({ queued: false, reason: "convite" });
    const texts = lastTexts(3);
    expect(texts.some((t) => t.startsWith("Ana aceitou seu convite.") && t.endsWith("Já entreguei o seu recado."))).toBe(true);
    expect(texts.some((t) => t.startsWith("Pronto, vocês agora são contatos!"))).toBe(true);
    expect(texts.at(-1)).toBe("*David Queiroz* te mandou pelo Planejai:\n\nbora no cinema amanhã?\n\n_Para responder, é só me dizer o que falar pro David._");
    expect((await social.findContact(david.id, "ana")).map((c) => c.id)).toEqual([ana.id]);
  });
});
