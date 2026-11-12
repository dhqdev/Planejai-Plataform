import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Rede social: perfil opt-in, feed, curtida, comentário, seguir, bloqueio, status de 24h, denúncia e moderação. */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
// PNG 1x1 de verdade (o servidor confere o começo do arquivo)
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe.skipIf(!enabled)("rede social (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let app: any;
  const cookieOf = (res: any) => String(res.headers["set-cookie"]).split(";")[0]!;
  const call = (cookie: string, method: string, url: string, payload?: unknown) => app.inject({ method, url, headers: { cookie }, payload });

  async function person(phone: string, name: string, email: string) {
    const { hashPassword } = await import("../src/accounts.js");
    const u = await db.one("INSERT INTO users (phone, name, status) VALUES ($1, $2, 'active') RETURNING id", [phone, name]);
    await db.query("INSERT INTO accounts (email, name, password_hash, role, status, user_id, phone) VALUES ($1, $2, $3, 'admin', 'active', $4, $5)", [email, name, hashPassword("senha-forte-123"), u.id, phone]);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "senha-forte-123" } });
    expect(login.statusCode).toBe(200);
    return { id: u.id as string, cookie: cookieOf(login) };
  }

  let ana: { id: string; cookie: string };
  let beto: { id: string; cookie: string };
  let caio: { id: string; cookie: string };
  let owner: string;

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    const { buildServer } = await import("../src/api/server.js");
    app = await buildServer();
    ana = await person("5519922220001", "Ana Paula", "ana.rede@x.com");
    beto = await person("5519922220002", "Beto", "beto.rede@x.com");
    caio = await person("5519922220003", "Caio", "caio.rede@x.com");
    owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } }));
  });
  afterAll(async () => {
    await app?.close();
  });

  it("sem perfil a pessoa só olha (vê o feed, mas não publica); a sugestão usa só o primeiro nome", async () => {
    const me = (await call(ana.cookie, "GET", "/api/feed/me")).json();
    expect(me.profile).toBeNull();
    expect(me.canJoin).toBe(true);
    expect(me.suggestion).toEqual({ handle: "ana", name: "Ana" });
    for (const u of ["/api/feed", "/api/feed/status", "/api/feed/people"]) expect((await call(ana.cookie, "GET", u)).statusCode, u).toBe(200);
    for (const [u, body] of [["/api/feed/posts", { body: "oi" }], ["/api/feed/status", { body: "oi" }]] as const) {
      const r = await call(ana.cookie, "POST", u, body);
      expect(r.statusCode, u).toBe(403);
      expect(r.json().needsProfile).toBe(true);
    }
  });

  it("cria o perfil com @ válido e único", async () => {
    expect((await call(ana.cookie, "PUT", "/api/feed/me", { handle: "a", name: "Ana" })).statusCode).toBe(400);
    expect((await call(ana.cookie, "PUT", "/api/feed/me", { handle: "admin", name: "Ana" })).statusCode).toBe(400);
    const ok = await call(ana.cookie, "PUT", "/api/feed/me", { handle: "@Ana.Paula", name: "Ana Paula", bio: "Planejo tudo." });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().profile).toMatchObject({ handle: "ana.paula", name: "Ana Paula", me: true, posts: 0 });
    expect((await call(beto.cookie, "PUT", "/api/feed/me", { handle: "ANA.PAULA", name: "Beto" })).statusCode).toBe(409);
    expect((await call(beto.cookie, "PUT", "/api/feed/me", { handle: "beto", name: "Beto" })).statusCode).toBe(200);
    expect((await call(caio.cookie, "PUT", "/api/feed/me", { handle: "caio", name: "Caio" })).statusCode).toBe(200);
  });

  let postId = "";
  it("publica com foto, aparece no feed dos outros, e a foto só abre para quem está na rede", async () => {
    expect((await call(ana.cookie, "POST", "/api/feed/posts", { body: "   " })).statusCode).toBe(400);
    expect((await call(ana.cookie, "POST", "/api/feed/posts", { body: "x", photos: [{ base64: Buffer.from("<script>alert(1)</script>").toString("base64") }] })).statusCode).toBe(400);
    const r = await call(ana.cookie, "POST", "/api/feed/posts", { body: "Primeiro post ‮do feed", photos: [{ base64: PNG, width: 1, height: 1 }] });
    expect(r.statusCode).toBe(200);
    const post = r.json().post;
    postId = post.id;
    expect(post.body).toBe("Primeiro post do feed");
    expect(post.media).toHaveLength(1);
    expect(post.author.handle).toBe("ana.paula");
    // telefone, e-mail e nome do WhatsApp nunca vão junto
    expect(r.body).not.toMatch(/5519922220001|ana\.rede@x\.com/);

    const feed = (await call(beto.cookie, "GET", "/api/feed")).json();
    expect(feed.posts.map((p: any) => p.id)).toEqual([postId]);
    expect(feed.posts[0].mine).toBe(false);
    expect((await call(beto.cookie, "GET", "/api/feed?tab=following")).json().posts).toHaveLength(0);

    const img = await call(beto.cookie, "GET", `/api/feed/media/${post.media[0].id}`);
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect((await app.inject({ method: "GET", url: `/api/feed/media/${post.media[0].id}` })).statusCode).toBe(401);
  });

  it("curtir, comentar e seguir viram atividade para a dona do post", async () => {
    expect((await call(beto.cookie, "POST", `/api/feed/posts/${postId}/like`)).json()).toEqual({ liked: true, likes: 1 });
    expect((await call(beto.cookie, "POST", `/api/feed/posts/${postId}/like`)).json().likes).toBe(1);
    const c = await call(beto.cookie, "POST", `/api/feed/posts/${postId}/comments`, { body: "Boa!" });
    expect(c.statusCode).toBe(200);
    expect((await call(beto.cookie, "POST", "/api/feed/u/ana.paula/follow")).json()).toEqual({ following: true });
    expect((await call(beto.cookie, "POST", "/api/feed/u/beto/follow")).statusCode).toBe(404);
    expect((await call(beto.cookie, "GET", "/api/feed?tab=following")).json().posts).toHaveLength(1);

    expect((await call(ana.cookie, "GET", "/api/feed/me")).json().unread).toBe(3);
    const act = (await call(ana.cookie, "GET", "/api/feed/activity")).json();
    expect(act.map((a: any) => a.kind).sort()).toEqual(["comment", "follow", "like"]);
    expect(act.every((a: any) => a.actor.handle === "beto" && a.unread)).toBe(true);
    expect((await call(ana.cookie, "GET", "/api/feed/me")).json().unread).toBe(0);

    const detail = (await call(ana.cookie, "GET", `/api/feed/posts/${postId}`)).json();
    expect(detail.post).toMatchObject({ likes: 1, comments: 1, liked: false, mine: true });
    expect(detail.comments[0]).toMatchObject({ body: "Boa!", canDelete: true });
    const prof = (await call(ana.cookie, "GET", "/api/feed/u/ana.paula")).json();
    expect(prof.profile).toMatchObject({ followers: 1, following: 0, posts: 1 });
    expect((await call(ana.cookie, "GET", "/api/feed/u/ana.paula/seguidores")).json().map((p: any) => p.handle)).toEqual(["beto"]);
    // só quem escreveu, a dona do post ou o dono da stack apaga o comentário
    expect((await call(caio.cookie, "DELETE", `/api/feed/comments/${detail.comments[0].id}`)).statusCode).toBe(404);
    expect((await call(caio.cookie, "DELETE", `/api/feed/posts/${postId}`)).statusCode).toBe(404);
  });

  it("status: aparece para os outros, conta quem viu só para quem postou e some depois de 24h", async () => {
    const s = await call(ana.cookie, "POST", "/api/feed/status", { body: "Bom dia!", bg: "roxo" });
    expect(s.statusCode).toBe(200);
    const id = s.json().id;
    const photo = (await call(ana.cookie, "POST", "/api/feed/status", { photo: { base64: PNG, width: 1, height: 1 } })).json().id;
    let groups = (await call(beto.cookie, "GET", "/api/feed/status")).json();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ seen: false, me: false });
    expect(groups[0].items.map((i: any) => i.kind)).toEqual(["text", "photo"]);
    expect(groups[0].items[0].views).toBeUndefined();
    await call(beto.cookie, "POST", `/api/feed/status/${id}/view`);
    await call(beto.cookie, "POST", `/api/feed/status/${photo}/view`);
    groups = (await call(beto.cookie, "GET", "/api/feed/status")).json();
    expect(groups[0].seen).toBe(true);
    expect((await call(beto.cookie, "GET", `/api/feed/status/${id}/viewers`)).statusCode).toBe(404);
    expect((await call(ana.cookie, "GET", `/api/feed/status/${id}/viewers`)).json().map((p: any) => p.handle)).toEqual(["beto"]);
    expect((await call(ana.cookie, "GET", "/api/feed/status")).json()[0].items[0].views).toBe(1);

    const mediaId = groups[0].items[1].media.id;
    await db.query("UPDATE feed_status SET expires_at = now() - interval '1 minute' WHERE id = $1", [photo]);
    expect((await call(beto.cookie, "GET", `/api/feed/media/${mediaId}`)).statusCode).toBe(404);
    const { purgeExpiredStatus } = await import("../src/feed.js");
    expect(await purgeExpiredStatus()).toBe(1);
    expect((await call(beto.cookie, "GET", "/api/feed/status")).json()[0].items).toHaveLength(1);
    expect((await call(beto.cookie, "DELETE", `/api/feed/status/${id}`)).statusCode).toBe(404);
  });

  it("bloqueio: um some para o outro (feed, perfil, foto, busca, status) e deixam de se seguir", async () => {
    expect((await call(ana.cookie, "POST", "/api/feed/u/caio/block")).json()).toEqual({ blocked: true });
    expect((await call(caio.cookie, "GET", "/api/feed")).json().posts).toHaveLength(0);
    expect((await call(caio.cookie, "GET", "/api/feed/u/ana.paula")).statusCode).toBe(404);
    expect((await call(caio.cookie, "GET", `/api/feed/posts/${postId}`)).statusCode).toBe(404);
    expect((await call(caio.cookie, "POST", `/api/feed/posts/${postId}/like`)).statusCode).toBe(404);
    expect((await call(caio.cookie, "GET", "/api/feed/status")).json()).toHaveLength(0);
    expect((await call(caio.cookie, "GET", "/api/feed/people?q=ana")).json()).toHaveLength(0);
    expect((await call(caio.cookie, "POST", "/api/feed/u/ana.paula/follow")).statusCode).toBe(403);
    expect((await call(ana.cookie, "DELETE", "/api/feed/u/caio/block")).json()).toEqual({ blocked: false });
    expect((await call(caio.cookie, "GET", "/api/feed")).json().posts).toHaveLength(1);
  });

  it("denúncia avisa o dono, que pode apagar; sair da rede leva tudo junto", async () => {
    expect((await call(ana.cookie, "POST", "/api/feed/report", { kind: "post", id: postId })).statusCode).toBe(400);
    expect((await call(caio.cookie, "POST", "/api/feed/report", { kind: "post", id: postId, reason: "spam" })).statusCode).toBe(200);
    await call(caio.cookie, "POST", "/api/feed/report", { kind: "post", id: postId, reason: "spam" });
    const notes = await db.many("SELECT title, link FROM notifications WHERE kind = 'rede'");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ title: "Denúncia na rede: uma publicação de @ana.paula", link: `/rede/p/${postId}` });

    // o dono entra na rede com o perfil dele e modera
    const { config } = await import("../src/config.js");
    config.OWNER_PHONES.push("5519922229999");
    await db.query("INSERT INTO users (phone, name, status) VALUES ('5519922229999', 'Dono', 'active')");
    expect((await call(owner, "PUT", "/api/feed/me", { handle: "dono", name: "Dono" })).statusCode).toBe(200);
    expect((await call(owner, "DELETE", `/api/feed/posts/${postId}`)).statusCode).toBe(200);
    expect((await call(beto.cookie, "GET", "/api/feed")).json().posts).toHaveLength(0);
    config.OWNER_PHONES.pop();

    await call(beto.cookie, "POST", "/api/feed/posts", { body: "Post do Beto" });
    expect((await call(beto.cookie, "DELETE", "/api/feed/me")).statusCode).toBe(200);
    expect((await db.one("SELECT count(*)::int AS n FROM feed_posts WHERE user_id = $1", [beto.id])).n).toBe(0);
    expect((await call(beto.cookie, "GET", "/api/feed")).statusCode).toBe(200);
    expect((await call(ana.cookie, "GET", "/api/feed/u/beto")).statusCode).toBe(404);
  });
});
