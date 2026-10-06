import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { safeEqual, signSession, verifySession } from "../crypto.js";
import { pool } from "../db/pool.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";

const COOKIE = "pj_session";

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const session = verifySession(req.cookies[COOKIE]);
  if (!session) return reply.code(401).send({ error: "não autenticado" });
}

export async function buildServer() {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: 25 * 1024 * 1024,
    trustProxy: true,
  });
  await app.register(cookie);

  // Guarda o corpo bruto para validar assinaturas de webhook (Meta X-Hub-Signature-256)
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    (req as any).rawBody = body;
    if (!(body as Buffer).length) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch (err) {
      (err as any).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { ok: true };
  });

  // Login simples de dono (ADMIN_EMAIL/ADMIN_PASSWORD do .env)
  app.post<{ Body: { email: string; password: string } }>("/api/auth/login", async (req, reply) => {
    const { email, password } = req.body ?? ({} as any);
    if (!email || !password || email.toLowerCase() !== config.ADMIN_EMAIL.toLowerCase() || !safeEqual(password, config.ADMIN_PASSWORD)) {
      await new Promise((r) => setTimeout(r, 500));
      return reply.code(401).send({ error: "E-mail ou senha incorretos" });
    }
    const token = signSession({ sub: email, exp: Date.now() + 7 * 86_400_000 });
    reply.setCookie(COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.PUBLIC_URL.startsWith("https"),
      maxAge: 7 * 86_400,
    });
    return { ok: true, email };
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req, reply) => {
    const s = verifySession(req.cookies[COOKIE]);
    if (!s) return reply.code(401).send({ error: "não autenticado" });
    return { email: s.sub };
  });

  await registerWebhookRoutes(app);
  await registerDashboardRoutes(app);

  // Dashboard (SPA) servido pelo mesmo container
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/webhooks/")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "não encontrado" });
    });
  }

  return app;
}
