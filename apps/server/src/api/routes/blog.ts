import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { BLOG_AUTHOR, BLOG_CATEGORIES } from "../../blog.js";
import { config } from "../../config.js";
import { many, one } from "../../db/pool.js";

/**
 * Blog público, sem login: lista, post, ilustrações, sitemap e feed RSS. O HTML de /blog/* sai com título, descrição e
 * imagem do post já no <head> (blogPage), para o Google e para a prévia do link no WhatsApp.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Row {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  category: string;
  excerpt: string;
  reading_minutes: number;
  published_at: Date;
  updated_at: Date;
  has_cover: boolean;
  has_inline: boolean;
}

const COLS = `p.id, p.slug, p.title, p.subtitle, p.category, p.excerpt, p.reading_minutes, p.published_at, p.updated_at,
  EXISTS (SELECT 1 FROM blog_images i WHERE i.post_id = p.id AND i.slot = 'cover') AS has_cover,
  EXISTS (SELECT 1 FROM blog_images i WHERE i.post_id = p.id AND i.slot = 'inline') AS has_inline`;

const img = (r: Row, slot: "cover" | "inline") => `/api/blog/img/${r.id}/${slot}?v=${new Date(r.updated_at).getTime()}`;

export const card = (r: Row) => ({
  id: r.id,
  slug: r.slug,
  title: r.title,
  subtitle: r.subtitle,
  category: r.category,
  excerpt: r.excerpt,
  reading_minutes: r.reading_minutes,
  published_at: r.published_at,
  author: BLOG_AUTHOR,
  cover: r.has_cover ? img(r, "cover") : null,
});

async function postBySlug(slug: string) {
  return one<Row & { body: string }>(`SELECT ${COLS}, p.body FROM blog_posts p WHERE p.slug = $1 AND p.status = 'published' AND p.published_at <= now()`, [slug]);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const base = () => config.PUBLIC_URL.replace(/\/$/, "");

export async function registerBlogRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { category?: string } }>("/api/blog/posts", async (req) => {
    const cat = BLOG_CATEGORIES.find((c) => c === req.query.category) ?? null;
    const rows = await many<Row>(
      `SELECT ${COLS} FROM blog_posts p WHERE p.status = 'published' AND p.published_at <= now() AND ($1::text IS NULL OR p.category = $1)
        ORDER BY p.published_at DESC LIMIT 60`,
      [cat],
    );
    return { categories: BLOG_CATEGORIES, posts: rows.map(card) };
  });

  app.get<{ Params: { slug: string } }>("/api/blog/posts/:slug", async (req, reply) => {
    const r = await postBySlug(String(req.params.slug).slice(0, 120));
    if (!r) return reply.code(404).send({ error: "post não encontrado" });
    const related = await many<Row>(
      `SELECT ${COLS} FROM blog_posts p WHERE p.status = 'published' AND p.published_at <= now() AND p.id <> $1
        ORDER BY (p.category = $2) DESC, p.published_at DESC LIMIT 3`,
      [r.id, r.category],
    );
    return { post: { ...card(r), body: r.body, inline: r.has_inline ? img(r, "inline") : null }, related: related.map(card) };
  });

  app.get<{ Params: { id: string; slot: string }; Querystring: { v?: string } }>("/api/blog/img/:id/:slot", async (req, reply) => {
    const { id, slot } = req.params;
    if (!UUID.test(id) || (slot !== "cover" && slot !== "inline")) return reply.code(404).send({ error: "não encontrado" });
    const row = await one<{ mimetype: string; data: Buffer }>(
      `SELECT i.mimetype, i.data FROM blog_images i JOIN blog_posts p ON p.id = i.post_id
        WHERE i.post_id = $1 AND i.slot = $2 AND p.status = 'published'`,
      [id, slot],
    );
    if (!row) return reply.code(404).send({ error: "não encontrado" });
    reply.header("Cache-Control", req.query.v ? "public, max-age=31536000, immutable" : "public, max-age=3600");
    return reply.type(row.mimetype).send(row.data);
  });

  app.get("/sitemap.xml", async (_req, reply) => {
    const rows = await many<{ slug: string; updated_at: Date }>(
      "SELECT slug, updated_at FROM blog_posts WHERE status = 'published' AND published_at <= now() ORDER BY published_at DESC LIMIT 1000",
    );
    const urls = [`<url><loc>${base()}/</loc></url>`, `<url><loc>${base()}/blog</loc></url>`].concat(
      rows.map((r) => `<url><loc>${base()}/blog/${esc(r.slug)}</loc><lastmod>${new Date(r.updated_at).toISOString().slice(0, 10)}</lastmod></url>`),
    );
    reply.header("Cache-Control", "public, max-age=3600");
    return reply.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`);
  });

  app.get("/blog/feed.xml", async (_req, reply) => {
    const rows = await many<Row>(`SELECT ${COLS} FROM blog_posts p WHERE p.status = 'published' AND p.published_at <= now() ORDER BY p.published_at DESC LIMIT 30`);
    const items = rows
      .map(
        (r) =>
          `<item><title>${esc(r.title)}</title><link>${base()}/blog/${esc(r.slug)}</link><guid>${base()}/blog/${esc(r.slug)}</guid>` +
          `<pubDate>${new Date(r.published_at).toUTCString()}</pubDate><category>${esc(r.category)}</category><description>${esc(r.excerpt)}</description></item>`,
      )
      .join("");
    reply.header("Cache-Control", "public, max-age=3600");
    return reply
      .type("application/rss+xml; charset=utf-8")
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Blog do Planejai</title><link>${base()}/blog</link><description>Rotina, dinheiro e IA no dia a dia.</description><language>pt-BR</language>${items}</channel></rss>`);
  });
}

let indexCache: { file: string; mtime: number; html: string } | null = null;

/** index.html do painel com o <head> do blog (título, descrição, imagem e dados estruturados). null = segue o normal. */
export async function blogPage(publicDir: string, url: string): Promise<string | null> {
  const path = url.split("?")[0]!.replace(/\/+$/, "");
  if (path !== "/blog" && !path.startsWith("/blog/")) return null;
  const file = join(publicDir, "index.html");
  const mtime = statSync(file, { throwIfNoEntry: false })?.mtimeMs;
  if (mtime == null) return null;
  if (!indexCache || indexCache.file !== file || indexCache.mtime !== mtime) indexCache = { file, mtime, html: readFileSync(file, "utf8") };
  let title = "Blog do Planejai: rotina, dinheiro e IA no dia a dia";
  let description = "Dicas práticas para organizar a semana, cuidar do dinheiro e usar inteligência artificial a seu favor, direto do time do Planejai.";
  let image: string | null = null;
  let ld: Record<string, unknown> | null = null;
  if (path.startsWith("/blog/")) {
    const r = await postBySlug(decodeURIComponent(path.slice(6)).slice(0, 120)).catch(() => null);
    if (r) {
      title = `${r.title} | Blog do Planejai`;
      description = r.subtitle || r.excerpt;
      image = r.has_cover ? `${base()}${img(r, "cover")}` : null;
      ld = {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        headline: r.title,
        description,
        datePublished: new Date(r.published_at).toISOString(),
        dateModified: new Date(r.updated_at).toISOString(),
        author: { "@type": "Organization", name: BLOG_AUTHOR },
        publisher: { "@type": "Organization", name: "Planejai" },
        mainEntityOfPage: `${base()}/blog/${r.slug}`,
        ...(image ? { image } : {}),
      };
    }
  }
  const canonical = `${base()}${path}`;
  const head =
    `<meta name="description" content="${esc(description)}">` +
    `<link rel="canonical" href="${esc(canonical)}">` +
    `<link rel="alternate" type="application/rss+xml" title="Blog do Planejai" href="/blog/feed.xml">` +
    `<meta property="og:type" content="${ld ? "article" : "website"}"><meta property="og:title" content="${esc(title)}">` +
    `<meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(canonical)}">` +
    (image ? `<meta property="og:image" content="${esc(image)}"><meta name="twitter:card" content="summary_large_image">` : "") +
    (ld ? `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>` : "");
  return indexCache.html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/<meta name="description"[^>]*>/, "")
    .replace("</head>", `${head}</head>`);
}
