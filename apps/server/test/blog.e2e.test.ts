import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Blog público: posts de partida entram uma vez, ilustrações saem da rota "image", o redator semanal é conferido
 * (JSON ruim volta uma vez), a lista e o post abrem sem login, post escondido some e só o super admin mexe.
 */
process.env.OPENROUTER_API_KEY ||= "sk-test";
const enabled = Boolean(process.env.TEST_DATABASE_URL);

const png = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.alloc(4000, 7)]).toString("base64");
const writer: string[] = [];
const calls: any[] = [];
vi.mock("../src/llm/openrouter.js", async (orig) => ({
  ...(await orig<typeof import("../src/llm/openrouter.js")>()),
  chatCompletion: vi.fn(async (_choice: any, req: any) => {
    calls.push(req);
    if (req.modalities) return { message: { content: "", images: [`data:image/png;base64,${png}`] }, model: "fake/image", tokensIn: 10, tokensOut: 1290, costUsd: 0.039 };
    return { message: { content: writer.shift() ?? "{}" }, model: "fake/blog", tokensIn: 900, tokensOut: 2500, costUsd: 0.002 };
  }),
}));

const longBody = (n = 5) =>
  "Abertura do post com uma ideia boa — e travessão que vira vírgula.\n\nSegundo parágrafo da abertura.\n\n" +
  Array.from({ length: n }, (_, i) => `## Seção ${i + 1}\n\n${"Texto prático e útil para o dia a dia. ".repeat(14)}\n\n- item um\n- item dois`).join("\n\n") +
  "\n\n## Perguntas frequentes\n\n### Funciona?\n\nFunciona.";
const good = (title = "Como montar uma reserva de emergência do zero") =>
  JSON.stringify({ title, subtitle: "Passo a passo simples.", category: "dinheiro e finanças", body: longBody(), cover_prompt: "A piggy bank on a mint background with coins", inline_prompt: "Three jars with coins" });

describe("blog: conferência do redator", () => {
  it("cleanDraft limpa, encaixa a ilustração do meio e recusa o que não serve", async () => {
    const { cleanDraft, slugify, excerptOf } = await import("../src/blog.js");
    const d: any = cleanDraft(JSON.parse(good()));
    expect(d.category).toBe("Dinheiro e finanças");
    expect(d.body).not.toMatch(/—/);
    expect(d.body.split("[[imagem]]").length).toBe(2);
    expect(d.body.indexOf("[[imagem]]")).toBeLessThan(d.body.indexOf("## Seção 3"));
    expect(cleanDraft({ ...JSON.parse(good()), body: "curto" })).toMatch(/curto/);
    expect(cleanDraft({ ...JSON.parse(good()), cover_prompt: "" })).toMatch(/cover_prompt/);
    expect(cleanDraft({ ...JSON.parse(good()), body: `<script>x</script>${longBody()}` }).toString()).not.toContain("<script>");
    expect(slugify("Regra 50-30-20: Ação & Reação!")).toBe("regra-50-30-20-acao-reacao");
    expect(excerptOf("## Título\n\nPrimeiro **parágrafo** de verdade.")).toBe("Primeiro parágrafo de verdade.");
  });

  it("os posts de partida passam na mesma conferência", async () => {
    const { cleanDraft } = await import("../src/blog.js");
    const { SEED_POSTS } = await import("../src/blog-seed.js");
    for (const p of SEED_POSTS) expect(typeof cleanDraft(p), p.slug).toBe("object");
    expect(new Set(SEED_POSTS.map((p) => p.slug)).size).toBe(SEED_POSTS.length);
  });
});

describe.skipIf(!enabled)("blog (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let blog: typeof import("../src/blog.js");
  let app: any;
  const log = { info: () => {}, error: () => {}, warn: () => {} };
  const cookieOf = (res: any) => String(res.headers["set-cookie"]).split(";")[0]!;

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await db.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    blog = await import("../src/blog.js");
    const { buildServer } = await import("../src/api/server.js");
    app = await buildServer();
  });
  afterAll(async () => {
    await (await import("../src/queue/boss.js")).stopBoss().catch(() => {});
    await app?.close();
  });

  it("a rodada de hora em hora põe os posts de partida e ilustra quatro por vez", async () => {
    await blog.saveBlogSettings({ auto: false });
    await blog.runBlogJob(log, { action: "tick" });
    const posts = await db.many<{ slug: string; source: string }>("SELECT slug, source FROM blog_posts");
    expect(posts.length).toBe(4);
    expect((await db.one<{ n: number }>("SELECT count(*)::int AS n FROM blog_images"))!.n).toBe(4);
    const img = calls.find((c) => c.modalities);
    expect(img.imageConfig).toEqual({ aspect_ratio: "16:9" });
    expect(img.messages[0].content).toContain("gouache");
    // apagar tudo não traz os de partida de volta
    await db.query("DELETE FROM blog_posts WHERE source = 'seed' AND slug = $1", [posts[0]!.slug]);
    await blog.runBlogJob(log, { action: "tick" });
    expect((await db.one<{ n: number }>("SELECT count(*)::int AS n FROM blog_posts"))!.n).toBe(3);
  });

  it("lista, post, ilustração e head para o Google abrem sem login", async () => {
    const list = (await app.inject({ method: "GET", url: "/api/blog/posts" })).json();
    expect(list.categories).toContain("Comparações");
    expect(list.posts[0]).toMatchObject({ author: "Equipe Planejai" });
    const withCover = list.posts.find((p: any) => p.cover);
    expect(withCover.cover).toMatch(/^\/api\/blog\/img\/.+\/cover\?v=\d+$/);
    const img = await app.inject({ method: "GET", url: withCover.cover });
    expect(img.statusCode).toBe(200);
    expect(img.headers["cache-control"]).toContain("immutable");
    const one = (await app.inject({ method: "GET", url: `/api/blog/posts/${withCover.slug}` })).json();
    expect(one.post.body).toContain("## ");
    expect(one.related.length).toBe(2);
    expect((await app.inject({ method: "GET", url: "/api/blog/posts/nao-existe" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/blog/img/nao-e-uuid/cover" })).statusCode).toBe(404);
    const filtered = (await app.inject({ method: "GET", url: `/api/blog/posts?category=${encodeURIComponent(withCover.category)}` })).json();
    expect(filtered.posts.every((p: any) => p.category === withCover.category)).toBe(true);
    const sitemap = await app.inject({ method: "GET", url: "/sitemap.xml" });
    expect(sitemap.body).toContain(`/blog/${withCover.slug}`);
    expect((await app.inject({ method: "GET", url: "/blog/feed.xml" })).body).toContain("<rss");

    const dir = mkdtempSync(join(tmpdir(), "pj-blog-"));
    writeFileSync(join(dir, "index.html"), '<!doctype html><html><head><title>Planejai</title><meta name="description" content="x"></head><body></body></html>');
    const { blogPage } = await import("../src/api/routes/blog.js");
    const html = (await blogPage(dir, `/blog/${withCover.slug}`))!;
    expect(html).toContain(`<title>${one.post.title.replace(/&/g, "&amp;")} | Blog do Planejai</title>`);
    expect(html).toContain('property="og:image"');
    expect(html).toContain("application/ld+json");
    expect((html.match(/name="description"/g) ?? []).length).toBe(1);
    expect(await blogPage(dir, "/blog-posts")).toBeNull();
    expect(await blogPage(dir, "/agenda")).toBeNull();
  });

  it("o redator semanal: JSON ruim volta uma vez, depois publica com capa e ilustração do meio", async () => {
    calls.length = 0;
    writer.push('{"title":"curto"}', good());
    const post = await blog.writePost("manual", log);
    expect(post!.title).toBe("Como montar uma reserva de emergência do zero");
    const writes = calls.filter((c) => !c.modalities);
    expect(writes.length).toBe(2);
    expect(writes[1].messages.at(-1).content).toMatch(/Não serviu/);
    expect(writes[0].messages[1].content).toContain("Posts que já existem");
    const imgs = await db.many("SELECT slot FROM blog_images WHERE post_id = $1 ORDER BY slot", [post!.id]);
    expect(imgs.map((i: any) => i.slot)).toEqual(["cover", "inline"]);
    const exec = await db.one<{ trigger: string; cost_usd: string }>("SELECT trigger, cost_usd FROM executions WHERE trigger = 'blog' ORDER BY started_at DESC LIMIT 1");
    expect(Number(exec!.cost_usd)).toBeGreaterThan(0);
    // mesmo título de novo ganha outro endereço
    writer.push(good());
    const again = await blog.writePost("manual", log);
    expect(again!.slug).toBe(`${post!.slug}-2`);
  });

  it("post da semana: só no dia e hora escolhidos e com o último post de mais de 6 dias", async () => {
    const now = new Date();
    const { tzOffsetMs } = await import("../src/time.js");
    const local = new Date(now.getTime() + tzOffsetMs(now, "America/Sao_Paulo"));
    await blog.saveBlogSettings({ auto: true, weekday: local.getUTCDay(), hour: 0 });
    expect(await blog.weeklyDue(now)).toBe(false); // acabou de sair um post
    await db.query("UPDATE blog_posts SET published_at = now() - interval '8 days'");
    expect(await blog.weeklyDue(now)).toBe(true);
    await blog.saveBlogSettings({ weekday: (local.getUTCDay() + 1) % 7 });
    expect(await blog.weeklyDue(now)).toBe(false);
    await blog.saveBlogSettings({ auto: false, weekday: local.getUTCDay() });
    expect(await blog.weeklyDue(now)).toBe(false);
  });

  it("painel: só super admin; esconder tira do blog público", async () => {
    expect((await app.inject({ method: "GET", url: "/api/blog-admin" })).statusCode).toBe(401);
    const owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } }));
    const data = (await app.inject({ method: "GET", url: "/api/blog-admin", headers: { cookie: owner } })).json();
    expect(data.posts.length).toBeGreaterThan(3);
    const p = data.posts[0];
    expect((await app.inject({ method: "PATCH", url: `/api/blog-admin/${p.id}`, headers: { cookie: owner }, payload: { status: "hidden" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/blog/posts/${p.slug}` })).statusCode).toBe(404);
    const s = (await app.inject({ method: "PUT", url: "/api/blog-admin/settings", headers: { cookie: owner }, payload: { weekday: 9, hour: 30 } })).json();
    expect(s.settings).toMatchObject({ weekday: 6, hour: 23 });
    expect((await app.inject({ method: "DELETE", url: `/api/blog-admin/${p.id}`, headers: { cookie: owner } })).statusCode).toBe(200);
  });
});
