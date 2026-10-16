import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Status do WhatsApp: a cena do Bolinho sai da rota barata "image" em 9:16 com a figurinha de referência, o post do blog
 * reaproveita a capa e o link, só vai para quem conversa pelo WhatsApp, e o automático fica desligado até o dono ligar.
 */
process.env.OPENROUTER_API_KEY ||= "sk-test";
const enabled = Boolean(process.env.TEST_DATABASE_URL);

const png = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.alloc(3000, 7)]).toString("base64");
const calls: any[] = [];
const choices: any[] = [];
vi.mock("../src/llm/openrouter.js", async (orig) => ({
  ...(await orig<typeof import("../src/llm/openrouter.js")>()),
  chatCompletion: vi.fn(async (choice: any, req: any) => {
    calls.push(req);
    choices.push(choice);
    return { message: { content: "", images: [`data:image/png;base64,${png}`] }, model: "fake/image", tokensIn: 10, tokensOut: 1290, costUsd: 0.039 };
  }),
}));

const posted: { status: any; jids: string[] }[] = [];
vi.mock("../src/channels/index.js", async (orig) => {
  const real = await orig<typeof import("../src/channels/index.js")>();
  return {
    ...real,
    getChannel: (id: string) =>
      id === "baileys"
        ? {
            ...real.getChannel(id),
            postStatus: async (status: any, jids: string[]) => {
              posted.push({ status, jids });
              return { id: "wamid-status" };
            },
          }
        : real.getChannel(id),
  };
});

describe("status do WhatsApp: regras", () => {
  it("cena que ficou mais tempo sem sair vem primeiro, 1 a cada N é do blog e o custo conta só as cenas", async () => {
    const s = await import("../src/wa-status.js");
    expect(s.nextScene([]).id).toBe(s.SCENES[0]!.id);
    const used = s.SCENES.map((x, i) => ({ scene: x.id, at: new Date(2026, 0, 1 + i) }));
    used[3]!.at = new Date(2025, 0, 1);
    expect(s.nextScene(used).id).toBe(s.SCENES[3]!.id);
    const base = { enabled: true, everyDays: 2, hour: 10, blogEvery: 3 };
    expect([0, 1, 2, 3, 4, 5].map((count) => s.nextKind({ ...base, count }))).toEqual(["imagem", "imagem", "blog", "imagem", "imagem", "blog"]);
    expect(s.nextKind({ ...base, blogEvery: 0, count: 2 })).toBe("imagem");
    expect(s.monthlyCostUsd(base)).toBe(0.39); // 15 posts, 10 cenas
    expect(s.monthlyCostUsd({ ...base, blogEvery: 0 })).toBe(0.59);
    expect(new Set(s.SCENES.map((x) => x.id)).size).toBe(s.SCENES.length);
    for (const x of s.SCENES) expect(x.caption.length, x.id).toBeLessThan(200);
  });

  it("conta com LID: lista toda em LID com o próprio número; PN sem LID fica de fora; sem LID segue em PN", async () => {
    await import("../src/channels/index.js");
    const { statusAudienceJids } = await import("../src/channels/baileys.js");
    const map: Record<string, string> = { "5511900000001@s.whatsapp.net": "111@lid" };
    const sock: any = {
      user: { id: "5511999990000:7@s.whatsapp.net" },
      authState: { creds: { me: { id: "5511999990000:7@s.whatsapp.net", lid: "999:7@lid" } } },
      signalRepository: { lidMapping: { getLIDForPN: async (pn: string) => map[pn] ?? null } },
    };
    expect(await statusAudienceJids(sock, ["5511900000001@s.whatsapp.net", "5511900000002@s.whatsapp.net", "222@lid"])).toEqual(["999@lid", "111@lid", "222@lid"]);
    sock.authState.creds.me.lid = undefined;
    expect(await statusAudienceJids(sock, ["5511900000001@s.whatsapp.net", "222@lid"])).toEqual(["5511999990000@s.whatsapp.net", "5511900000001@s.whatsapp.net"]);
  });

  it("só posta ligado, depois da hora escolhida, até 21h e passados os dias", async () => {
    const { statusDue } = await import("../src/wa-status.js");
    const s = { enabled: true, everyDays: 2, hour: 10, blogEvery: 3 };
    const at = (iso: string) => new Date(iso); // fuso da stack: America/Sao_Paulo (UTC-3)
    expect(statusDue({ ...s, enabled: false }, at("2026-10-16T15:00:00Z"))).toBe(false);
    expect(statusDue(s, at("2026-10-16T12:00:00Z"))).toBe(false); // 9h
    expect(statusDue(s, at("2026-10-16T13:30:00Z"))).toBe(true); // 10h30, nunca postou
    expect(statusDue(s, at("2026-10-17T01:00:00Z"))).toBe(false); // 22h
    expect(statusDue({ ...s, lastAt: "2026-10-15T13:30:00Z" }, at("2026-10-16T13:30:00Z"))).toBe(false); // 1 dia
    expect(statusDue({ ...s, lastAt: "2026-10-14T13:30:00Z" }, at("2026-10-16T12:30:00Z"))).toBe(false); // 9h30 ainda
    expect(statusDue({ ...s, lastAt: "2026-10-14T14:30:00Z" }, at("2026-10-16T13:30:00Z"))).toBe(true); // folga de 2 h não empurra o horário
    expect(statusDue({ ...s, failedAt: "2026-10-16T12:00:00Z" }, at("2026-10-16T14:00:00Z"))).toBe(false);
  });
});

describe.skipIf(!enabled)("status do WhatsApp (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let st: typeof import("../src/wa-status.js");
  let app: any;
  const log = { info: () => {}, error: () => {}, warn: () => {} };
  const cookieOf = (res: any) => String(res.headers["set-cookie"]).split(";")[0]!;

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    st = await import("../src/wa-status.js");
    // os testes rodam com WHATSAPP_PROVIDER=none; o canal Baileys aqui é falso (mock acima)
    (await import("../src/config.js")).config.WHATSAPP_PROVIDER = "baileys";
    const { buildServer } = await import("../src/api/server.js");
    app = await buildServer();
    // duas pessoas no WhatsApp, uma bloqueada e uma só no Telegram
    for (const [phone, status, channel, jid] of [
      ["5511900000001", "active", "baileys", "5511900000001@s.whatsapp.net"],
      ["5511900000002", "active", "baileys", "123456789@lid"],
      ["5511900000003", "blocked", "baileys", "5511900000003@s.whatsapp.net"],
      ["5511900000004", "active", "telegram", "tg:99"],
    ] as const) {
      const u = await db.one<{ id: string }>("INSERT INTO users (phone, status) VALUES ($1, $2) RETURNING id", [phone, status]);
      await db.query("INSERT INTO conversations (user_id, channel, remote_jid) VALUES ($1, $2, $3)", [u!.id, channel, jid]);
    }
  });
  afterAll(async () => {
    await (await import("../src/queue/boss.js")).stopBoss().catch(() => {});
    await app?.close();
  });

  it("desligado por padrão: a rodada não gera nem posta nada", async () => {
    expect((await st.statusSettings()).enabled).toBe(false);
    await st.runStatusTick(log);
    expect(calls.length).toBe(0);
    expect(posted.length).toBe(0);
  });

  it("cena do Bolinho: rota barata, 9:16, figurinha de referência; posta só para quem fala pelo WhatsApp", async () => {
    const d = await st.makeDraft("imagem");
    const req = calls.at(-1);
    expect(choices.at(-1).model).toBe("google/gemini-2.5-flash-image");
    expect(req.imageConfig).toEqual({ aspect_ratio: "9:16" });
    expect(req.messages[0].content[0].text).toContain("Bolinho");
    expect(req.messages[0].content[1].image_url.url).toMatch(/^data:image\/webp;base64,/);
    const row = await db.one<{ status: string; caption: string; scene: string }>("SELECT status, caption, scene FROM wa_status_posts WHERE id = $1", [d!.id]);
    expect(row).toMatchObject({ status: "rascunho", scene: st.SCENES[0]!.id });
    expect(posted.length).toBe(0); // rascunho não sai

    expect(await st.postDraft(d!.id)).toBe(2);
    expect(posted[0]!.jids.sort()).toEqual(["123456789@lid", "5511900000001@s.whatsapp.net"]);
    expect(posted[0]!.status).toMatchObject({ kind: "image", caption: row!.caption });
    await expect(st.postDraft(d!.id)).rejects.toThrow(/já foi postado/);
  });

  it("post do blog reaproveita a capa e manda o link; sem post novo, vira cena", async () => {
    const p = await db.one<{ id: string }>(
      `INSERT INTO blog_posts (slug, title, subtitle, category, body, cover_prompt, status, source)
       VALUES ('reserva', 'Reserva de emergência', 'Do zero', 'Dinheiro e finanças', 'texto', 'cena', 'published', 'manual') RETURNING id`,
    );
    await db.query("INSERT INTO blog_images (post_id, slot, mimetype, data) VALUES ($1, 'cover', 'image/jpeg', $2)", [p!.id, Buffer.from("capa")]);
    const before = calls.length;
    const d = await st.makeDraft("blog");
    expect(calls.length).toBe(before);
    const row = await db.one<{ caption: string; kind: string }>("SELECT caption, kind FROM wa_status_posts WHERE id = $1", [d!.id]);
    expect(row!.kind).toBe("blog");
    expect(row!.caption).toContain("/blog/reserva");
    // o mesmo post não vai duas vezes: o próximo pedido de blog vira cena
    await st.makeDraft("blog");
    expect(calls.length).toBe(before + 1);
  });

  it("ligado e na hora: o automático posta e marca a data; painel só para o super admin", async () => {
    await st.saveStatusSettings({ enabled: true, hour: 7 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T15:00:00Z"));
    try {
      await st.runStatusTick(log);
    } finally {
      vi.useRealTimers();
    }
    const s = await st.statusSettings();
    expect(s.count).toBe(1);
    expect(s.lastAt).toBe("2026-10-16T15:00:00.000Z");
    expect(posted.length).toBe(2);

    const owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } }));
    const data = (await app.inject({ method: "GET", url: "/api/whatsapp/status-posts", headers: { cookie: owner } })).json();
    expect(data.audience).toBe(2);
    expect(data.posts.length).toBe(4);
    const draft = data.posts.find((x: any) => x.status === "rascunho");
    const img = await app.inject({ method: "GET", url: `/api/whatsapp/status-posts/${draft.id}/img`, headers: { cookie: owner } });
    expect(img.statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/api/whatsapp/status-posts/${draft.id}`, headers: { cookie: owner }, payload: { caption: "" } })).statusCode).toBe(400);
    const saved = (await app.inject({ method: "PUT", url: "/api/whatsapp/status-settings", headers: { cookie: owner }, payload: { everyDays: 99, hour: 3, enabled: false } })).json();
    expect(saved.settings).toMatchObject({ everyDays: 14, hour: 7, enabled: false });
    expect((await app.inject({ method: "GET", url: "/api/whatsapp/status-posts" })).statusCode).toBe(401);
  });
});
