import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { safeEqual, signSession, verifySession } from "../crypto.js";
import { hashPassword, loadAccount, normalizePhone, OWNER_ID, ownerAccount, toAccount, verifyPassword, type Account } from "../accounts.js";
import { one, pool, query } from "../db/pool.js";
import { phoneVariants } from "../ingest.js";
import { getSettings } from "../settings.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";

const COOKIE = "pj_session";

declare module "fastify" {
  interface FastifyRequest {
    account: Account;
  }
}

/** Exige login. Coloca a conta em req.account (recarregada a cada pedido: bloqueio vale na hora). */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const session = verifySession(req.cookies[COOKIE]);
  const account = session ? await loadAccount(session.sub) : null;
  if (!account) return reply.code(401).send({ error: "não autenticado" });
  if (account.status !== "active") return reply.code(403).send({ error: account.status === "pending" ? "Conta aguardando aprovação" : "Conta desativada" });
  req.account = account;
}

/** Só o super admin (dono da stack e quem ele promover). */
export async function requireSuper(req: FastifyRequest, reply: FastifyReply) {
  if (req.account?.role !== "superadmin") return reply.code(403).send({ error: "Só o super admin pode fazer isso" });
}

function setSession(reply: FastifyReply, sub: string) {
  const token = signSession({ sub, exp: Date.now() + 7 * 86_400_000 });
  reply.setCookie(COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.PUBLIC_URL.startsWith("https"),
    maxAge: 7 * 86_400,
  });
}

const publicAccount = (a: Account) => ({ id: a.id, email: a.email, name: a.name, role: a.role, status: a.status, phone: a.phone, owner: a.owner, linked: Boolean(a.userId) });

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

  // Login: dono da stack (.env) ou conta cadastrada
  app.post<{ Body: { email: string; password: string } }>("/api/auth/login", async (req, reply) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    const fail = async () => {
      await new Promise((r) => setTimeout(r, 500));
      return reply.code(401).send({ error: "E-mail ou senha incorretos" });
    };
    if (!email || !password) return fail();
    if (email === config.ADMIN_EMAIL.toLowerCase()) {
      if (!safeEqual(password, config.ADMIN_PASSWORD)) return fail();
      setSession(reply, OWNER_ID);
      return publicAccount(ownerAccount());
    }
    const row = await one("SELECT * FROM accounts WHERE email = $1", [email]);
    if (!row || !verifyPassword(password, row.password_hash)) return fail();
    if (row.status === "pending") return reply.code(403).send({ error: "Seu cadastro está aguardando aprovação do administrador." });
    if (row.status === "disabled") return reply.code(403).send({ error: "Conta desativada." });
    await query("UPDATE accounts SET last_login_at = now() WHERE id = $1", [row.id]);
    setSession(reply, row.id);
    return publicAccount(toAccount(row));
  });

  // Cadastro público: vira admin da própria conta (vê só os próprios dados), ligado ao número do WhatsApp
  app.post<{ Body: { name?: string; email?: string; password?: string; phone?: string } }>("/api/auth/register", async (req, reply) => {
    const { signupMode } = await getSettings();
    if (signupMode === "closed") return reply.code(403).send({ error: "Cadastros estão fechados." });
    const name = String(req.body?.name ?? "").trim().slice(0, 80);
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    const phone = normalizePhone(req.body?.phone ?? "");
    if (!name) return reply.code(400).send({ error: "Informe seu nome" });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ error: "E-mail inválido" });
    if (password.length < 8) return reply.code(400).send({ error: "A senha precisa ter pelo menos 8 caracteres" });
    if (phone.length < 12 || phone.length > 15) return reply.code(400).send({ error: "Informe o WhatsApp com DDD (ex.: 19 99999-9999)" });
    if (email === config.ADMIN_EMAIL.toLowerCase() || (await one("SELECT 1 FROM accounts WHERE email = $1", [email]))) {
      return reply.code(409).send({ error: "Já existe uma conta com esse e-mail" });
    }
    const open = signupMode === "open";
    // Liga à pessoa do WhatsApp (cria se ainda não falou com o assistente)
    const variants = phoneVariants(phone);
    let user = await one("SELECT * FROM users WHERE phone = ANY($1)", [variants]);
    if (!user) user = await one("INSERT INTO users (phone, name, status) VALUES ($1, $2, $3) RETURNING *", [phone, name, open ? "active" : "pending"]);
    else if (open && user.status === "pending") await query("UPDATE users SET status = 'active', name = COALESCE(name, $2) WHERE id = $1", [user.id, name]);
    const row = await one(
      `INSERT INTO accounts (email, name, password_hash, role, status, user_id, phone) VALUES ($1, $2, $3, 'admin', $4, $5, $6) RETURNING *`,
      [email, name, hashPassword(password), open ? "active" : "pending", user.id, phone],
    );
    if (open) {
      setSession(reply, row.id);
      return { ...publicAccount(toAccount(row)), pending: false };
    }
    return { ok: true, pending: true, message: "Cadastro recebido! Assim que o administrador aprovar você já pode entrar." };
  });

  app.get("/api/auth/config", async () => ({ signupMode: (await getSettings()).signupMode }));

  app.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: requireAuth }, async (req) => publicAccount(req.account));

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
