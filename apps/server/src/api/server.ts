import cookie from "@fastify/cookie";
import { COMMIT, VERSION } from "../version.js";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { safeEqual, signSession, verifySession } from "../crypto.js";
import { bumpSession, hashPassword, loadAccount, normalizePhone, ownerAccount, toAccount, verifyPassword, type Account } from "../accounts.js";
import { hit, peek } from "../ratelimit.js";
import { one, pool, query } from "../db/pool.js";
import { phoneVariants } from "../ingest.js";
import { cleanInviteCode } from "../social.js";
import { pricingOf } from "../billing.js";
import { getSettings } from "../settings.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerInternalRoutes } from "./routes/internal.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerSecurity, trustProxySetting } from "./security.js";
import { DEVICE_COOKIE, isTrustedDevice, startChallenge, startReset, startSignupChallenge, trustDevice, verifyChallenge, verifyReset, verifySignup, whatsappReady } from "../logincode.js";
import { emitEvent } from "../events.js";
import { notify } from "../notifications.js";
import { QUEUES, getBoss } from "../queue/boss.js";

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
    trustProxy: trustProxySetting(),
  });
  await app.register(cookie);
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
  registerSecurity(app, publicDir);

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
    return { ok: true, version: VERSION, commit: COMMIT };
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
      return finishLogin(req, reply, await ownerAccount());
    }
    const row = await one("SELECT * FROM accounts WHERE email = $1", [email]);
    if (!row || !verifyPassword(password, row.password_hash)) return fail();
    if (row.status === "pending") return reply.code(403).send({ error: "Seu cadastro está aguardando aprovação do administrador." });
    if (row.status === "disabled") return reply.code(403).send({ error: "Conta desativada." });
    return finishLogin(req, reply, toAccount(row));
  });

  // Senha certa: navegador conhecido entra direto; navegador novo recebe um código no WhatsApp
  async function finishLogin(req: FastifyRequest, reply: FastifyReply, account: Account) {
    if (!(await isTrustedDevice(account.id, req.cookies[DEVICE_COOKIE]))) {
      const ch = await startChallenge(account, (phone, text) =>
        getBoss().then((b) => b.send(QUEUES.outbound, { type: "send", userId: null, phone, channel: "whatsapp", text }, { retryLimit: 1 })),
      );
      if (ch.needs_code) return { needs_code: true, challenge: ch.challenge, to: ch.to };
    }
    return completeLogin(req, reply, account, false);
  }

  async function completeLogin(req: FastifyRequest, reply: FastifyReply, account: Account, newDevice: boolean) {
    if (!account.owner) await query("UPDATE accounts SET last_login_at = now() WHERE id = $1", [account.id]);
    if (newDevice) {
      const token = await trustDevice(account.id, req.headers["user-agent"]);
      reply.setCookie(DEVICE_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", secure: config.PUBLIC_URL.startsWith("https"), maxAge: 365 * 86_400 });
      await notify({ userId: account.owner ? null : account.userId, kind: "seguranca", title: "Novo acesso ao painel", body: `Navegador novo confirmado pelo código do WhatsApp (${String(req.headers["user-agent"] ?? "").slice(0, 80)}).` });
    }
    setSession(reply, account);
    return publicAccount(account);
  }

  app.post<{ Body: { challenge?: string; code?: string } }>("/api/auth/login/verify", async (req, reply) => {
    if ((await hit(`login:verify:${req.ip}`, LOGIN_WINDOW)) > LOGIN_IP_MAX) return tooMany(reply);
    const r = await verifyChallenge(String(req.body?.challenge ?? ""), String(req.body?.code ?? ""));
    if (!r.ok) return reply.code(401).send({ error: r.error });
    const account = await loadAccount(r.accountId);
    if (!account || account.status !== "active") return reply.code(403).send({ error: "Conta indisponível." });
    return completeLogin(req, reply, account, true);
  });

  // Esqueci a senha: código no WhatsApp (pelo fluxo do n8n, com plano B pela nossa fila) e senha nova
  app.post<{ Body: { email?: string } }>("/api/auth/forgot", async (req, reply) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if ((await hit(`forgot:ip:${req.ip}`, LOGIN_WINDOW)) > 10) return tooMany(reply);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ error: "Informe o e-mail da sua conta." });
    if ((await hit(`forgot:mail:${email}`, 3600)) > 3) return tooMany(reply);
    const row = await one("SELECT * FROM accounts WHERE email = $1", [email]);
    const r = await startReset(row ? toAccount(row) : null, async (d) => {
      const sent = await emitEvent("password.reset_requested", { user_id: d.userId, account_id: d.accountId, phone: d.phone, name: d.name, code: d.code, text: d.text, minutes: 15 });
      if (!sent) await (await getBoss()).send(QUEUES.outbound, { type: "send", userId: null, phone: d.phone, channel: "whatsapp", text: d.text }, { retryLimit: 1 });
    });
    return { challenge: r.challenge };
  });

  app.post<{ Body: { challenge?: string; code?: string; password?: string } }>("/api/auth/reset", async (req, reply) => {
    if ((await hit(`forgot:verify:${req.ip}`, LOGIN_WINDOW)) > LOGIN_IP_MAX) return tooMany(reply);
    const password = String(req.body?.password ?? "");
    if (password.length < 8) return reply.code(400).send({ error: "A senha precisa ter pelo menos 8 caracteres" });
    const r = await verifyReset(String(req.body?.challenge ?? ""), String(req.body?.code ?? ""));
    if (!r.ok) return reply.code(401).send({ error: r.error });
    const account = await loadAccount(r.accountId);
    if (!account || account.owner || account.status !== "active") return reply.code(403).send({ error: "Conta indisponível." });
    await query("UPDATE accounts SET password_hash = $2 WHERE id = $1", [account.id, hashPassword(password)]);
    // senha nova derruba os outros logins; quem provou o WhatsApp agora entra direto
    await bumpSession(account.id);
    await notify({ userId: account.userId, kind: "seguranca", title: "Senha trocada", body: "Sua senha foi trocada pelo código do WhatsApp. Os outros aparelhos saíram." });
    const fresh = await loadAccount(account.id);
    return completeLogin(req, reply, fresh!, true);
  });

  // Convite público: dados para a tela de cadastro (/convite/:code ou o código digitado na landing)
  app.get<{ Params: { code: string } }>("/api/invite/:code", async (req, reply) => {
    // limitar por IP impede varrer códigos atrás de convites válidos
    if ((await hit(`invite:ip:${req.ip}`, 15 * 60)) > 60) return tooMany(reply);
    const inv = await one(
      `SELECT i.name, i.phone, i.email, i.status, i.expires_at, COALESCE(u.full_name, u.name, a.name) AS inviter
         FROM invites i LEFT JOIN users u ON u.id = i.inviter_user_id LEFT JOIN accounts a ON a.id = i.inviter_account_id WHERE i.code = $1`,
      [cleanInviteCode(req.params.code)],
    );
    if (!inv || inv.status === "declined" || inv.status === "expired") return reply.code(404).send({ error: "Não achei esse convite. Confira o código." });
    // convite por código serve uma vez só
    if (!inv.phone && inv.status !== "pending") return reply.code(410).send({ error: "Esse convite já foi usado. Peça um novo a quem te convidou." });
    if (new Date(inv.expires_at) < new Date()) return reply.code(410).send({ error: "Esse convite expirou. Os códigos valem 24 horas: peça um novo a quem te convidou." });
    const used = inv.phone ? await one("SELECT 1 FROM accounts WHERE phone = ANY($1)", [phoneVariants(inv.phone)]) : null;
    return { name: inv.name, email: inv.email, phone: inv.phone, inviter: inv.inviter, used: Boolean(used), expires_at: inv.expires_at };
  });

  // Cadastro: no modo convite (padrão) só entra quem tem o código; vira admin da própria conta, ligado ao WhatsApp
  app.post<{ Body: { name?: string; email?: string; password?: string; phone?: string; code?: string; accept_terms?: boolean; challenge?: string; verify_code?: string } }>("/api/auth/register", async (req, reply) => {
    if ((await hit(`register:ip:${req.ip}`, 3600)) > 20) return tooMany(reply);
    const { signupMode } = await getSettings();
    if (signupMode === "closed") return reply.code(403).send({ error: "Cadastros estão fechados." });
    const code = cleanInviteCode(req.body?.code);
    const found = code
      ? await one("SELECT * FROM invites WHERE code = $1 AND status IN ('pending', 'accepted') AND expires_at > now()", [code])
      : null;
    // convite por código (sem telefone) serve um cadastro só
    const invite = found && (found.phone || found.status === "pending") ? found : null;
    if (code && !invite) return reply.code(400).send({ error: found ? "Esse convite já foi usado. Peça um novo a quem te convidou." : "Convite inválido ou expirado" });
    if (signupMode === "invite" && !invite) return reply.code(403).send({ error: "O Planejai é só por convite. Peça um convite a quem já usa." });
    const name = String(req.body?.name ?? invite?.name ?? "").trim().slice(0, 80);
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    const phone = invite?.phone ? invite.phone : normalizePhone(req.body?.phone ?? "");
    if (!name) return reply.code(400).send({ error: "Informe seu nome" });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ error: "E-mail inválido" });
    if (password.length < 8) return reply.code(400).send({ error: "A senha precisa ter pelo menos 8 caracteres" });
    if (phone.length < 12 || phone.length > 15) return reply.code(400).send({ error: "Informe o WhatsApp com DDD (ex.: 19 99999-9999)" });
    if (req.body?.accept_terms !== true) return reply.code(400).send({ error: "Para criar a conta, aceite os termos de uso e a política de privacidade." });
    if (email === config.ADMIN_EMAIL.toLowerCase() || (await one("SELECT 1 FROM accounts WHERE email = $1", [email]))) {
      return reply.code(409).send({ error: "Já existe uma conta com esse e-mail" });
    }
    // um WhatsApp, uma conta: vale para todo tipo de convite (o convite por telefone não pode ser reusado por outra pessoa)
    const variants = phoneVariants(phone);
    const taken = await one(
      "SELECT 1 FROM accounts WHERE phone = ANY($1) OR user_id IN (SELECT id FROM users WHERE phone = ANY($1))",
      [variants],
    );
    if (taken) return reply.code(409).send({ error: "Esse WhatsApp já tem conta. Entre com seu e-mail e senha." });
    // prova de que o número é da pessoa: código no WhatsApp antes de criar a conta
    if (config.LOGIN_CODE) {
      if (!req.body?.challenge) {
        if ((await hit(`register:phone:${phone}`, 3600)) > 5) return tooMany(reply);
        if (!(await whatsappReady())) return reply.code(503).send({ error: "Não consegui mandar o código no WhatsApp agora. Tente de novo em alguns minutos." });
        const ch = await startSignupChallenge(phone, email, (to, text) =>
          getBoss().then((b) => b.send(QUEUES.outbound, { type: "send", userId: null, phone: to, channel: "whatsapp", text }, { retryLimit: 1 })),
        );
        return { needs_code: true, challenge: ch.challenge, to: ch.to };
      }
      const ok = await verifySignup(String(req.body.challenge), String(req.body?.verify_code ?? ""), phone, email);
      if (!ok.ok) return reply.code(401).send({ error: ok.error });
    }
    if (invite && !invite.phone) {
      // marca o código como usado antes de criar a conta: dois cadastros ao mesmo tempo não usam o mesmo convite
      const claimed = await one("UPDATE invites SET status = 'accepted', responded_at = now() WHERE id = $1 AND status = 'pending' RETURNING id", [invite.id]);
      if (!claimed) return reply.code(400).send({ error: "Esse convite já foi usado. Peça um novo a quem te convidou." });
    }
    // convite vale como aprovação
    const open = signupMode === "open" || Boolean(invite);
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
      await query("UPDATE invites SET status = 'accepted', responded_at = COALESCE(responded_at, now()), invitee_user_id = $2 WHERE id = $1", [invite.id, user.id]);
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

  // público (tela de entrar e landing): modo de cadastro e a vitrine de planos e grãos
  app.get("/api/auth/config", async () => {
    const s = await getSettings();
    // planos e pacotes de grãos: a landing mostra a vitrine mesmo com a cobrança desligada
    // quem responde pelos dados, para a página /privacidade (LGPD)
    const legal = { name: s.legalName, document: s.legalDocument, email: s.privacyEmail, city: s.legalCity };
    // regras das compras pelo assistente (termos de compra e privacidade mostram os números do dono)
    const { purchaseRules } = await import("../purchases.js");
    return { signupMode: s.signupMode, version: VERSION, pricing: pricingOf(s), legal, purchases: purchaseRules(s) };
  });

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
  await registerNotificationRoutes(app);

  // Dashboard (SPA) servido pelo mesmo container
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, {
      root: publicDir,
      wildcard: false,
      cacheControl: false,
      setHeaders(reply, path) {
        // arquivos com hash nunca mudam; o resto (index, sw.js, manifest) sempre revalida para o PWA atualizar
        reply.header("Cache-Control", path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
        if (path.endsWith("sw.js")) reply.header("Service-Worker-Allowed", "/");
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
