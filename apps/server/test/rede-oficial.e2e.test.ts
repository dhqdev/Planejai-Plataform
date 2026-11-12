import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Perfil oficial do Planejai na rede: posts de partida, espelho do blog e do status do WhatsApp, sem repetir. */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
// 3h da manhã em São Paulo: a pauta do dia ainda não sai
const NIGHT = new Date("2026-11-12T06:00:00Z");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe.skipIf(!enabled)("perfil oficial na rede (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let app: any;
  let cookie = "";

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    const { buildServer } = await import("../src/api/server.js");
    app = await buildServer();
    const { hashPassword } = await import("../src/accounts.js");
    const u = await db.one("INSERT INTO users (phone, name, status) VALUES ('5519933330001', 'Dora', 'active') RETURNING id");
    await db.query("INSERT INTO accounts (email, name, password_hash, role, status, user_id, phone) VALUES ('dora@x.com', 'Dora', $1, 'admin', 'active', $2, '5519933330001')", [hashPassword("senha-forte-123"), u.id]);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "dora@x.com", password: "senha-forte-123" } });
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  });
  afterAll(async () => {
    await app?.close();
  });

  it("cria o @planejai com selo e os posts de partida uma vez só", async () => {
    const { syncOfficialFeed, SEED } = await import("../src/feed-oficial.js");
    expect(SEED.length).toBeGreaterThanOrEqual(20);
    expect((await syncOfficialFeed(NIGHT)).seeded).toBe(SEED.length);
    expect((await syncOfficialFeed(NIGHT)).seeded).toBe(0);
    // sem perfil a pessoa já vê o feed
    const feed = (await app.inject({ method: "GET", url: "/api/feed", headers: { cookie } })).json();
    expect(feed.posts).toHaveLength(20);
    expect(feed.posts[0].author).toMatchObject({ handle: "planejai", name: "Planejai", official: true });
    expect(feed.posts.some((p: any) => p.card)).toBe(true);
    // fora da lista de Pessoas e das contagens
    const owner = String((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } })).headers["set-cookie"]).split(";")[0]!;
    const clients = (await app.inject({ method: "GET", url: "/api/clients", headers: { cookie: owner } })).json();
    expect(clients.some((c: any) => c.phone.startsWith("planejai"))).toBe(false);
  });

  it("pessoas de exemplo curtem e comentam aos poucos, sem repetir e sem mexer em post de gente de verdade", async () => {
    const { syncOfficialFeed } = await import("../src/feed-oficial.js");
    const { PEOPLE, EXAMPLE_POSTS } = await import("../src/feed-exemplo.js");
    const people = await db.many("SELECT u.phone, u.status FROM users u JOIN feed_profiles f ON f.user_id = u.id WHERE u.phone LIKE 'planejai-ex-%'");
    expect(people).toHaveLength(PEOPLE.length);
    expect(people.every((p: any) => p.status === "blocked")).toBe(true);
    expect((await db.one("SELECT count(*)::int AS n FROM feed_posts WHERE source LIKE 'ex:post:%'")).n).toBe(EXAMPLE_POSTS.length);
    const before = await db.one("SELECT (SELECT count(*)::int FROM feed_likes) AS l, (SELECT count(*)::int FROM feed_comments) AS c");
    expect(before.l).toBeGreaterThan(50);
    expect(before.c).toBeGreaterThan(20);
    // de novo, na mesma hora: nada repete
    const again = await syncOfficialFeed(NIGHT);
    expect(again.crowd).toMatchObject({ posts: 0, likes: 0, comments: 0 });
    // o de boas-vindas tem os comentários escritos para ele, na ordem
    const welcome = await db.one("SELECT id FROM feed_posts WHERE source = 'seed:1'");
    const post = (await app.inject({ method: "GET", url: `/api/feed/posts/${welcome.id}`, headers: { cookie } })).json();
    expect(post.comments.map((c: any) => c.body)[0]).toBe("Que legal ter um lugar assim. Bora trocar dicas!");
    expect(post.post.likes).toBeGreaterThan(0);
    expect(post.post.likes).toBeLessThan(PEOPLE.length);
    // nada chega no futuro: um post de agora ainda está sem curtida; horas depois, já tem
    const { syncExampleCrowd } = await import("../src/feed-exemplo.js");
    const official = (await db.one("SELECT id FROM users WHERE phone = 'planejai'")).id;
    await syncExampleCrowd(official, new Date(NIGHT.getTime() + 24 * 3600_000));
    expect((await db.one("SELECT count(*)::int AS n FROM feed_likes WHERE post_id = $1", [welcome.id])).n).toBe(PEOPLE.length);
    const fresh = await db.one("INSERT INTO feed_posts (user_id, body, source, created_at) VALUES ($1, 'teste', 'pauta:teste:2026-11-12', $2) RETURNING id", [official, NIGHT]);
    await syncExampleCrowd(official, NIGHT);
    expect((await db.one("SELECT count(*)::int AS n FROM feed_likes WHERE post_id = $1", [fresh.id])).n).toBe(0);
    await syncExampleCrowd(official, new Date(NIGHT.getTime() + 6 * 3600_000));
    expect((await db.one("SELECT count(*)::int AS n FROM feed_likes WHERE post_id = $1", [fresh.id])).n).toBeGreaterThanOrEqual(3);
    await db.query("DELETE FROM feed_posts WHERE id = $1", [fresh.id]);
    // post de gente de verdade fica quieto
    expect((await db.one("SELECT count(*)::int AS n FROM feed_likes l JOIN feed_posts p ON p.id = l.post_id WHERE p.source IS NULL")).n).toBe(0);
  });

  it("quem cria o perfil já segue o Planejai", async () => {
    expect((await app.inject({ method: "PUT", url: "/api/feed/me", headers: { cookie }, payload: { handle: "dora", name: "Dora" } })).statusCode).toBe(200);
    const following = (await app.inject({ method: "GET", url: "/api/feed?tab=following", headers: { cookie } })).json();
    expect(following.posts.length).toBeGreaterThan(0);
    expect((await app.inject({ method: "PUT", url: "/api/feed/me", headers: { cookie }, payload: { handle: "planejai.oficial", name: "Dora" } })).statusCode).toBe(400);
  });

  it("post do blog vira cartão de link com capa e status do WhatsApp vira post e status de 24h", async () => {
    const blog = await db.one(
      "INSERT INTO blog_posts (slug, title, subtitle, category, excerpt, body) VALUES ('organizar-a-semana', 'Como organizar a semana', 'Em 10 minutos', 'Organização e rotina', 'Um jeito simples.', 'texto') RETURNING id",
    );
    await db.query("INSERT INTO blog_images (post_id, slot, mimetype, data) VALUES ($1, 'cover', 'image/png', $2)", [blog.id, Buffer.from(PNG, "base64")]);
    await db.query(
      "INSERT INTO wa_status_posts (kind, scene, caption, mimetype, data, status, posted_at) VALUES ('imagem', 'praia', 'Contas pagas e *hoje* eu tirei folga', 'image/png', $1, 'postado', now() - interval '1 hour')",
      [Buffer.from(PNG, "base64")],
    );
    const { syncOfficialFeed } = await import("../src/feed-oficial.js");
    expect(await syncOfficialFeed(NIGHT)).toMatchObject({ seeded: 0, blog: 1, status: 1, pauta: 0 });
    expect(await syncOfficialFeed(NIGHT)).toMatchObject({ seeded: 0, blog: 0, status: 0, pauta: 0 });
    const feed = (await app.inject({ method: "GET", url: "/api/feed", headers: { cookie } })).json();
    const link = feed.posts.find((p: any) => p.link);
    expect(link.link).toMatchObject({ title: "Como organizar a semana", desc: "Em 10 minutos" });
    expect(link.link.url).toMatch(/\/blog\/organizar-a-semana$/);
    expect(link.media).toHaveLength(1);
    const wa = feed.posts.find((p: any) => p.body.startsWith("Contas pagas"));
    expect(wa.body).toBe("Contas pagas e hoje eu tirei folga");
    expect(wa.media[0]).toMatchObject({ w: 1, h: 1 });
    const status = (await app.inject({ method: "GET", url: "/api/feed/status", headers: { cookie } })).json();
    expect(status[0].author.handle).toBe("planejai");
    expect(status[0].items[0].kind).toBe("photo");
  });

  it("pauta: um post por dia, os de época primeiro e sem repetir até rodar a lista", async () => {
    const { syncOfficialFeed } = await import("../src/feed-oficial.js");
    const { PAUTA, nextPauta } = await import("../src/feed-pauta.js");
    expect(PAUTA.length).toBeGreaterThanOrEqual(40);
    expect(new Set(PAUTA.map((p) => p.id)).size).toBe(PAUTA.length);
    // novembro, meio-dia em São Paulo: sai um de novembro (13º ou Black Friday) e só um no dia
    const noon = new Date("2026-11-12T15:00:00Z");
    expect((await syncOfficialFeed(noon)).pauta).toBe(1);
    expect((await syncOfficialFeed(new Date("2026-11-12T20:00:00Z"))).pauta).toBe(0);
    const first = await db.one("SELECT source FROM feed_posts WHERE source LIKE 'pauta:%'");
    expect(first.source).toMatch(/^pauta:cal-(13|black):2026-11-12$/);
    expect((await syncOfficialFeed(new Date("2026-11-13T15:00:00Z"))).pauta).toBe(1);
    const two = await db.many("SELECT source FROM feed_posts WHERE source LIKE 'pauta:%'");
    expect(new Set(two.map((r: any) => r.source.split(":")[1])).size).toBe(2);
    // fora da época não sai post de outro mês
    const july = nextPauta([], 7, new Date("2026-07-10T15:00:00Z"));
    expect(july!.months ?? [7]).toContain(7);
  });
});
