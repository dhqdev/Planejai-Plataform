import type { FastifyInstance } from "fastify";
import { blogSettings, saveBlogSettings } from "../../../blog.js";
import { config } from "../../../config.js";
import { many, one, query } from "../../../db/pool.js";
import { QUEUES, getBoss } from "../../../queue/boss.js";

/** Blog no painel (super admin): ver os posts, escrever um agora, esconder, apagar, refazer ilustração e o post semanal. */
export function blogAdminRoutes(api: FastifyInstance) {
  api.get("/api/blog-admin", async () => {
    const posts = await many(
      `SELECT p.id, p.slug, p.title, p.category, p.status, p.source, p.published_at, p.reading_minutes, p.updated_at,
              (p.inline_prompt IS NOT NULL AND p.body LIKE '%[[imagem]]%') AS wants_inline,
              EXISTS (SELECT 1 FROM blog_images i WHERE i.post_id = p.id AND i.slot = 'cover') AS has_cover,
              EXISTS (SELECT 1 FROM blog_images i WHERE i.post_id = p.id AND i.slot = 'inline') AS has_inline,
              (SELECT last_error FROM blog_image_failures f WHERE f.post_id = p.id ORDER BY f.updated_at DESC LIMIT 1) AS image_error
         FROM blog_posts p ORDER BY p.published_at DESC LIMIT 200`,
    );
    const writing = await one<{ n: number }>(
      "SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND state IN ('created', 'retry', 'active') AND data->>'action' IN ('write', 'image')",
      [QUEUES.blog],
    ).catch(() => ({ n: 0 }));
    return { settings: await blogSettings(), posts, busy: (writing?.n ?? 0) > 0, ready: Boolean(config.OPENROUTER_API_KEY), timezone: config.DEFAULT_TIMEZONE };
  });

  api.put<{ Body: { auto?: boolean; weekday?: number; hour?: number } }>("/api/blog-admin/settings", async (req) => {
    const { auto, weekday, hour } = req.body ?? {};
    return { settings: await saveBlogSettings({ auto, weekday, hour }) };
  });

  // escreve um post agora (o worker faz; leva um ou dois minutos)
  api.post("/api/blog-admin/write", async () => {
    const boss = await getBoss();
    await boss.send(QUEUES.blog, { action: "write" }, { retryLimit: 0, expireInSeconds: 900 });
    return { ok: true };
  });

  api.post<{ Params: { id: string }; Body: { slot?: string } }>("/api/blog-admin/:id/image", async (req, reply) => {
    const slot = req.body?.slot === "inline" ? "inline" : "cover";
    if (!(await one("SELECT 1 FROM blog_posts WHERE id = $1", [req.params.id]))) return reply.code(404).send({ error: "post não encontrado" });
    const boss = await getBoss();
    await boss.send(QUEUES.blog, { action: "image", postId: req.params.id, slot }, { retryLimit: 0, expireInSeconds: 600 });
    return { ok: true };
  });

  api.patch<{ Params: { id: string }; Body: { status?: string } }>("/api/blog-admin/:id", async (req, reply) => {
    const status = req.body?.status === "hidden" ? "hidden" : "published";
    const r = await one("UPDATE blog_posts SET status = $2, updated_at = now() WHERE id = $1 RETURNING id", [req.params.id, status]);
    if (!r) return reply.code(404).send({ error: "post não encontrado" });
    return { ok: true };
  });

  api.delete<{ Params: { id: string } }>("/api/blog-admin/:id", async (req) => {
    await query("DELETE FROM blog_posts WHERE id = $1", [req.params.id]);
    return { ok: true };
  });
}
