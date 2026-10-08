import type { FastifyInstance } from "fastify";
import { hashPassword, loadAccount, verifyPassword } from "../../../accounts.js";
import { config } from "../../../config.js";
import { many, one, query } from "../../../db/pool.js";
import { eraseUserData } from "../../../privacy.js";
import { getOnboarding, ONBOARDING, saveOnboarding } from "../../../onboarding.js";
import { NOBODY, selfUserId } from "../../../sharing.js";
import { ESSENTIAL, getTabs, OPTIONAL } from "../../../tabs.js";
import { botUsername, connections, telegramLink, unlink } from "../../../telegram.js";
import { setSession } from "../../server.js";

/** A própria conta: resumo, perfil, senha, exclusão (LGPD), layout do painel, mascote, conexões e abas. */
export function meRoutes(base: FastifyInstance) {
  // ================= Dados da própria pessoa (particulares: o dono também vê só os dele) =================
  base.get("/api/me/overview", async (req) => {
    const uid = (await selfUserId(req.account)) ?? NOBODY;
    const tz = config.DEFAULT_TIMEZONE;
    const money = await one(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE kind='expense' AND date_trunc('month', occurred_at AT TIME ZONE $2) = date_trunc('month', now() AT TIME ZONE $2)),0) AS expenses_month,
              COALESCE(SUM(amount) FILTER (WHERE kind='income' AND date_trunc('month', occurred_at AT TIME ZONE $2) = date_trunc('month', now() AT TIME ZONE $2)),0) AS income_month,
              COALESCE(SUM(amount) FILTER (WHERE kind='expense' AND date_trunc('month', occurred_at AT TIME ZONE $2) = date_trunc('month', (now() - interval '1 month') AT TIME ZONE $2)),0) AS expenses_prev
         FROM transactions WHERE user_id = $1`,
      [uid, tz],
    );
    const counts = await one(
      `SELECT (SELECT COUNT(*) FROM reminders WHERE status = 'scheduled' AND user_id = $1) AS reminders,
              (SELECT COUNT(*) FROM memories WHERE user_id = $1) AS memories,
              (SELECT COALESCE(SUM(messages), 0) FROM usage_daily WHERE day = current_date AND user_id = $1) AS messages_24h,
              (SELECT COUNT(*) FROM watches WHERE active AND user_id = $1) AS watches`,
      [uid],
    );
    const byCategory = await many(
      `SELECT category, SUM(amount) AS total FROM transactions WHERE user_id = $1 AND kind = 'expense'
          AND date_trunc('month', occurred_at AT TIME ZONE $2) = date_trunc('month', now() AT TIME ZONE $2) GROUP BY category ORDER BY total DESC`,
      [uid, tz],
    );
    const nextReminders = await many(
      `SELECT id, intent, due_at, cron FROM reminders WHERE status = 'scheduled' AND user_id = $1 ORDER BY due_at ASC NULLS LAST LIMIT 5`,
      [uid],
    );
    const recent = await many(
      `SELECT id, kind, amount, category, description, merchant, occurred_at FROM transactions WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT 6`,
      [uid],
    );
    return { money, counts, byCategory, nextReminders, recent, account: { name: req.account.name, role: req.account.role, linked: Boolean(req.account.userId) } };
  });

  base.patch<{ Body: { name?: string; password?: string; current_password?: string; timezone?: string } }>("/api/me", async (req, reply) => {
    const a = req.account;
    if (a.owner) return reply.code(400).send({ error: "A conta do dono é configurada pelas variáveis ADMIN_EMAIL/ADMIN_PASSWORD da stack." });
    const row = await one("SELECT * FROM accounts WHERE id = $1", [a.id]);
    if (req.body.password) {
      if (req.body.password.length < 8) return reply.code(400).send({ error: "A senha precisa ter pelo menos 8 caracteres" });
      if (!verifyPassword(req.body.current_password ?? "", row.password_hash)) return reply.code(400).send({ error: "Senha atual incorreta" });
      await query("UPDATE accounts SET password_hash = $2, session_version = session_version + 1 WHERE id = $1", [a.id, hashPassword(req.body.password)]);
      // senha nova derruba os outros aparelhos; este continua logado com um token novo
      const fresh = await loadAccount(a.id);
      if (fresh) setSession(reply, fresh);
    }
    if (req.body.name) await query("UPDATE accounts SET name = $2 WHERE id = $1", [a.id, req.body.name.slice(0, 80)]);
    if (a.userId && (req.body.timezone || req.body.name)) {
      await query("UPDATE users SET timezone = COALESCE($2, timezone), name = COALESCE($3, name) WHERE id = $1", [a.userId, req.body.timezone ?? null, req.body.name ?? null]);
    }
    return { ok: true };
  });

  // LGPD: a pessoa apaga a própria conta e todos os dados dela (pede a senha de novo)
  base.delete<{ Body: { password?: string } }>("/api/me", async (req, reply) => {
    const a = req.account;
    if (a.owner) return reply.code(400).send({ error: "A conta do dono da stack não pode ser apagada pelo painel." });
    const row = await one("SELECT * FROM accounts WHERE id = $1", [a.id]);
    if (!row || !verifyPassword(String(req.body?.password ?? ""), row.password_hash)) return reply.code(400).send({ error: "Senha incorreta" });
    if (a.userId) await eraseUserData(a.userId);
    await query("DELETE FROM accounts WHERE id = $1", [a.id]);
    reply.clearCookie("pj_session", { path: "/" });
    return { ok: true };
  });

  base.get("/api/me/profile", async (req) => {
    const user = req.account.userId ? await one("SELECT id, phone, name, status, timezone FROM users WHERE id = $1", [req.account.userId]) : null;
    return { account: { email: req.account.email, name: req.account.name, role: req.account.role, phone: req.account.phone, owner: req.account.owner }, user };
  });

  // ---------- Perguntas de boas-vindas (cadastro): o resumo vai para o prompt do CTO ----------
  base.get("/api/me/onboarding", async (req) => {
    const uid = await selfUserId(req.account);
    const ob = uid ? await getOnboarding(uid) : null;
    return { questions: ONBOARDING, due: Boolean(uid) && !ob, answers: ob?.answers ?? {}, summary: ob?.summary ?? "" };
  });
  base.put<{ Body: { answers?: unknown; skip?: boolean } }>("/api/me/onboarding", async (req, reply) => {
    const uid = await selfUserId(req.account);
    if (!uid) return reply.code(400).send({ error: "Conta sem WhatsApp ligado" });
    const saved = await saveOnboarding(uid, req.body?.answers, req.body?.skip === true);
    return { ok: true, summary: saved.summary };
  });

  // ---------- Painel editável: layout de cada conta ----------
  base.get("/api/me/dashboard", async (req) => {
    if (req.account.owner) return (await one("SELECT value FROM settings WHERE key = 'owner_dashboard'"))?.value ?? null;
    return (await one("SELECT dashboard FROM accounts WHERE id = $1", [req.account.id]))?.dashboard ?? null;
  });
  base.put<{ Body: { widgets: unknown[] } }>("/api/me/dashboard", async (req, reply) => {
    const widgets = Array.isArray(req.body?.widgets) ? req.body.widgets.slice(0, 40) : null;
    if (!widgets) return reply.code(400).send({ error: "layout inválido" });
    const value = JSON.stringify({ widgets });
    if (value.length > 20_000) return reply.code(400).send({ error: "layout grande demais" });
    if (req.account.owner) {
      await query("INSERT INTO settings (key, value, updated_at) VALUES ('owner_dashboard', $1, now()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()", [value]);
    } else await query("UPDATE accounts SET dashboard = $2 WHERE id = $1", [req.account.id, value]);
    return { ok: true };
  });

  // ---------- Mochi, o mascote: roupinha escolhida por cada conta ----------
  base.get("/api/me/mascot", async (req) => {
    if (req.account.owner) return (await one("SELECT value FROM settings WHERE key = 'owner_mascot'"))?.value ?? null;
    return (await one("SELECT mascot FROM accounts WHERE id = $1", [req.account.id]))?.mascot ?? null;
  });
  base.put<{ Body: { outfit?: Record<string, unknown> } }>("/api/me/mascot", async (req, reply) => {
    const raw = req.body?.outfit;
    if (!raw || typeof raw !== "object") return reply.code(400).send({ error: "roupinha inválida" });
    const outfit: Record<string, string> = {};
    for (const slot of ["head", "eyes", "neck", "costume"]) {
      const v = (raw as Record<string, unknown>)[slot];
      if (typeof v === "string" && /^[a-z_]{1,24}$/.test(v)) outfit[slot] = v;
    }
    const value = JSON.stringify({ outfit });
    if (req.account.owner) {
      await query("INSERT INTO settings (key, value, updated_at) VALUES ('owner_mascot', $1, now()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()", [value]);
    } else await query("UPDATE accounts SET mascot = $2 WHERE id = $1", [req.account.id, value]);
    return { ok: true };
  });

  // ---------- Conexões (WhatsApp, Telegram) da própria pessoa ----------
  base.get("/api/me/connections", async (req) => {
    const uid = await selfUserId(req.account);
    const user = uid ? await one("SELECT phone FROM users WHERE id = $1", [uid]) : null;
    const links = uid ? await connections(uid) : [];
    const tg = links.find((l: any) => l.channel === "telegram");
    const bot = await botUsername();
    return {
      linked: Boolean(uid),
      whatsapp: user ? { phone: user.phone } : null,
      telegram: { available: Boolean(bot), bot, connected: tg ? { username: tg.username, since: tg.created_at } : null },
    };
  });
  base.post("/api/me/connections/telegram", async (req, reply) => {
    const uid = await selfUserId(req.account);
    if (!uid) return reply.code(400).send({ error: "Sua conta ainda não está ligada a um número de WhatsApp" });
    try {
      return await telegramLink(uid);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  base.delete("/api/me/connections/telegram", async (req) => {
    const uid = await selfUserId(req.account);
    if (uid) await unlink(uid, "telegram");
    return { ok: true };
  });

  // ---------- Abas do app: essencial para todo mundo, o resto liberado pela reunião noturna ----------
  base.get("/api/me/tabs", async (req) => {
    if (req.account.role === "superadmin") return { all: true, essential: ESSENTIAL, modules: Object.keys(OPTIONAL), custom: [], catalog: OPTIONAL };
    const tabs = req.account.userId ? await getTabs(req.account.userId) : { modules: [], custom: [] };
    return { all: false, essential: ESSENTIAL, ...tabs, catalog: OPTIONAL };
  });
}
