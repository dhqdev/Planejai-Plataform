import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { safeEqual, signSession, verifySession } from "../crypto.js";
import { bumpSession, hashPassword, loadAccount, normalizePhone, OWNER_ID, ownerAccount, toAccount, verifyPassword, type Account } from "../accounts.js";
import { hit, peek } from "../ratelimit.js";
import { one, pool, query } from "../db/pool.js";
import { phoneVariants } from "../ingest.js";
import { getSettings } from "../settings.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerInternalRoutes } from "./routes/internal.js";

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
  // senha trocada, conta desativada ou "sair de todos os aparelhos": token antigo não vale mais
  if (!account || session?.v !== account.sessionVersion) return reply.code(401).send({ error: "não autenticado" });
  if (account.status !== "active") return reply.code(403).send({ error: account.status === "pending" ? "Conta aguardando aprovação" : "Conta desativada" });
  req.account = account;
}

/** Só o super admin (dono da stack e quem ele promover). */
export async function requireSuper(req: FastifyRequest, reply: FastifyReply) {
  if (req.account?.role !== "superadmin") return reply.code(403).send({ error: "Só o super admin pode fazer isso" });
}

export function setSession(reply: FastifyReply, account: Account) {
  const token = signSession({ sub: account.id, v: account.sessionVersion, exp: Date.now() + 7 * 86_400_000 });
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
  // Força bruta: no máximo LOGIN_IP_MAX tentativas por IP e LOGIN_FAIL_MAX erros por e-mail a cada 15 min
  const LOGIN_WINDOW = 15 * 60;
  const LOGIN_IP_MAX = 30;
  const LOGIN_FAIL_MAX = 8;
  const tooMany = (reply: FastifyReply) =>
    reply.code(429).header("Retry-After", String(LOGIN_WINDOW)).send({ error: "Muitas tentativas. Espere 15 minutos e tente de novo." });

  app.post<{ Body: { email: string; password: string } }>("/api/auth/login", async (req, reply) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    if ((await hit(`login:ip:${req.ip}`, LOGIN_WINDOW)) > LOGIN_IP_MAX) return tooMany(reply);
    if (email && (await peek(`login:fail:${email}`)) >= LOGIN_FAIL_MAX) return tooMany(reply);
    const fail = async () => {
      if (email) await hit(`login:fail:${email}`, LOGIN_WINDOW);
      await new Promise((r) => setTimeout(r, 500));
      return reply.code(401).send({ error: "E-mail ou senha incorretos" });
    };
    if (!email || !password) return fail();
    if (email === config.ADMIN_EMAIL.toLowerCase()) {
      if (!safeEqual(password, config.ADMIN_PASSWORD)) return fail();
      const owner = await ownerAccount();
      setSession(reply, owner);
      return publicAccount(owner);
    }
    const row = await one("SELECT * FROM accounts WHERE email = $1", [email]);
    if (!row || !verifyPassword(password, row.password_hash)) return fail();
    if (row.status === "pending") return reply.code(403).send({ error: "Seu cadastro está aguardando aprovação do administrador." });
    if (row.status === "disabled") return reply.code(403).send({ error: "Conta desativada." });
    await query("UPDATE accounts SET last_login_at = now() WHERE id = $1", [row.id]);
    setSession(reply, toAccount(row));
    return publicAccount(toAccount(row));
  });

  // Convite público: dados para a tela de cadastro (/convite/:code)
  app.get<{ Params: { code: string } }>("/api/invite/:code", async (req, reply) => {
    // códigos têm 8 letras; limitar por IP impede varrer convites atrás de nomes e telefones
    if ((await hit(`invite:ip:${req.ip}`, 15 * 60)) > 60) return tooMany(reply);
    const inv = await one(
      `SELECT i.name, i.phone, i.email, i.status, i.expires_at, COALESCE(u.full_name, u.name, a.name) AS inviter
         FROM invites i LEFT JOIN users u ON u.id = i.inviter_user_id LEFT JOIN accounts a ON a.id = i.inviter_account_id WHERE i.code = $1`,
      [String(req.params.code).toUpperCase()],
    );
    if (!inv || inv.status === "declined" || inv.status === "expired" || new Date(inv.expires_at) < new Date()) return reply.code(404).send({ error: "Convite inválido ou expirado" });
    const used = await one("SELECT 1 FROM accounts WHERE phone = ANY($1)", [phoneVariants(inv.phone)]);
    return { name: inv.name, email: inv.email, phone: inv.phone, inviter: inv.inviter, used: Boolean(used) };
  });

  // Cadastro: no modo convite (padrão) só entra quem tem o código; vira admin da própria conta, ligado ao WhatsApp
  app.post<{ Body: { name?: string; email?: string; password?: string; phone?: string; code?: string; accept_terms?: boolean } }>("/api/auth/register", async (req, reply) => {
    if ((await hit(`register:ip:${req.ip}`, 3600)) > 20) return tooMany(reply);
    const { signupMode } = await getSettings();
    if (signupMode === "closed") return reply.code(403).send({ error: "Cadastros estão fechados." });
    const code = String(req.body?.code ?? "").trim().toUpperCase();
    const invite = code
      ? await one("SELECT * FROM invites WHERE code = $1 AND status IN ('pending', 'accepted') AND expires_at > now()", [code])
      : null;
    if (code && !invite) return reply.code(400).send({ error: "Convite inválido ou expirado" });
    if (signupMode === "invite" && !invite) return reply.code(403).send({ error: "O Planejai é só por convite. Peça um convite a quem já usa." });
    const name = String(req.body?.name ?? invite?.name ?? "").trim().slice(0, 80);
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    const phone = invite ? invite.phone : normalizePhone(req.body?.phone ?? "");
    if (!name) return reply.code(400).send({ error: "Informe seu nome" });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ error: "E-mail inválido" });
    if (password.length < 8) return reply.code(400).send({ error: "A senha precisa ter pelo menos 8 caracteres" });
    if (phone.length < 12 || phone.length > 15) return reply.code(400).send({ error: "Informe o WhatsApp com DDD (ex.: 19 99999-9999)" });
    if (req.body?.accept_terms !== true) return reply.code(400).send({ error: "Para criar a conta, aceite os termos de uso e a política de privacidade." });
    if (email === config.ADMIN_EMAIL.toLowerCase() || (await one("SELECT 1 FROM accounts WHERE email = $1", [email]))) {
      return reply.code(409).send({ error: "Já existe uma conta com esse e-mail" });
    }
    // convite vale como aprovação
    const open = signupMode === "open" || Boolean(invite);
    const variants = phoneVariants(phone);
    let user = await one("SELECT * FROM users WHERE phone = ANY($1)", [variants]);
    if (!user) {
      user = await one("INSERT INTO users (phone, name, full_name, email, status, invited_by, terms_accepted_at) VALUES ($1, $2, $2, $3, $4, $5, now()) RETURNING *", [
        phone,
        name,
        email,
        open ? "active" : "pending",
        invite?.inviter_user_id ?? null,
      ]);
    } else {
      await query(
        `UPDATE users SET full_name = COALESCE(full_name, $2), email = COALESCE(email, $3),
           status = CASE WHEN $4 AND status = 'pending' THEN 'active' ELSE status END, invited_by = COALESCE(invited_by, $5),
           terms_accepted_at = COALESCE(terms_accepted_at, now()) WHERE id = $1`,
        [user.id, name, email, open, invite?.inviter_user_id ?? null],
      );
    }
    if (invite && invite.status === "pending") {
      await query("UPDATE invites SET status = 'accepted', responded_at = now(), invitee_user_id = $2 WHERE id = $1", [invite.id, user.id]);
      if (invite.inviter_user_id) {
        await query("INSERT INTO contacts (user_id, contact_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING", [invite.inviter_user_id, user.id]);
      }
    }
    const row = await one(
      `INSERT INTO accounts (email, name, password_hash, role, status, user_id, phone, terms_accepted_at) VALUES ($1, $2, $3, 'admin', $4, $5, $6, now()) RETURNING *`,
      [email, name, hashPassword(password), open ? "active" : "pending", user.id, phone],
    );
    if (open) {
      setSession(reply, toAccount(row));
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

  // Sair de todos os aparelhos: derruba todos os logins desta conta, inclusive este
  app.post("/api/auth/logout-all", { preHandler: requireAuth }, async (req, reply) => {
    await bumpSession(req.account.id);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  await registerWebhookRoutes(app);
  await registerInternalRoutes(app);
  await registerDashboardRoutes(app);

  // Dashboard (SPA) servido pelo mesmo container
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, {
      root: publicDir,
      wildcard: false,
      cacheControl: false,
      setHeaders(res, path) {
        // arquivos com hash nunca mudam; o resto (index, sw.js, manifest) sempre revalida para o PWA atualizar
        res.setHeader("Cache-Control", path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
        if (path.endsWith("sw.js")) res.setHeader("Service-Worker-Allowed", "/");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      // arquivo do app que não existe (aba antiga depois de um deploy): 404 de verdade, não o index no lugar do JS
      if (req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/webhooks/") && !req.url.startsWith("/assets/")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "não encontrado" });
    });
  }

  return app;
}
