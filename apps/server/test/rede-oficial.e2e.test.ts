import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Perfil oficial do Planejai na rede: posts de partida, espelho do blog e do status do WhatsApp, sem repetir. */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
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
    expect((await syncOfficialFeed()).seeded).toBe(SEED.length);
    expect((await syncOfficialFeed()).seeded).toBe(0);
    // sem perfil a pessoa já vê o feed
    const feed = (await app.inject({ method: "GET", url: "/api/feed", headers: { cookie } })).json();
    expect(feed.posts).toHaveLength(20);
    expect(feed.posts[0].author).toMatchObject({ handle: "planejai", name: "Planejai", official: true });
    expect(feed.posts.some((p: any) => p.card)).toBe(true);
    // fora da lista de Pessoas e das contagens
    const owner = String((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } })).headers["set-cookie"]).split(";")[0]!;
    const clients = (await app.inject({ method: "GET", url: "/api/clients", headers: { cookie: owner } })).json();
    expect(clients.some((c: any) => c.phone === "planejai")).toBe(false);
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
    expect(await syncOfficialFeed()).toEqual({ seeded: 0, blog: 1, status: 1 });
    expect(await syncOfficialFeed()).toEqual({ seeded: 0, blog: 0, status: 0 });
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
});
