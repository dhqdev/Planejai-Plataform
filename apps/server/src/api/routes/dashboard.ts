import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { CTO, CTO_TOOLS, SPECIALISTS } from "../../agent/team.js";
import { activeChannel } from "../../channels/index.js";
import { config } from "../../config.js";
import { signSession, verifySession } from "../../crypto.js";
import { many, one, query } from "../../db/pool.js";
import { googleAuthUrl, googleExchangeCode, googleRedirectUri } from "../../integrations/google.js";
import { mercadolivreAuthUrl, mercadolivreExchangeCode } from "../../integrations/mercadolivre.js";
import { disconnect, getDef, isConnected, listIntegrations, rawCredentials, saveCredentials, setEnabled } from "../../integrations/registry.js";
import { listModels } from "../../llm/openrouter.js";
import { listRoutes, resetRoute, resolveModel, saveRoute } from "../../llm/router.js";
import { cancelReminder, createReminder, listReminders, reminderOccurrences, rescheduleReminder } from "../../reminders.js";
import { parseLocalDateTime } from "../../time.js";
import { googleApi } from "../../integrations/google.js";
import { getSettings, saveSettings } from "../../settings.js";
import { SESSION_ID, sendWaCommand } from "../../whatsapp/session.js";
import { hashPassword, normalizePhone, scopeUserId, verifyPassword } from "../../accounts.js";
import { phoneVariants } from "../../ingest.js";
import { CATEGORIES, parseAmount } from "../../agent/tools/finance.js";
import { cacheStats, redisInfo } from "../../shortmem.js";
import { createInvite, inviteLink, inviteStats, listContacts } from "../../social.js";
import { cancelWatch, listWatches } from "../../watches.js";
import { improveUser, dailyImprovement } from "../../improve.js";
import { requireAuth, requireSuper } from "../server.js";

const PLAYGROUND_PHONE = "playground";

export async function registerDashboardRoutes(app: FastifyInstance) {
  // Callback do OAuth do Google vem do navegador sem cookie de API garantido: valida pelo state assinado.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/api/integrations/google/oauth/callback", async (req, reply) => {
    if (req.query.error) return reply.redirect(`/integrations?error=${encodeURIComponent(req.query.error)}`);
    if (!verifySession(req.query.state)?.sub.startsWith("oauth:")) return reply.code(400).send("state inválido");
    try {
      await googleExchangeCode(req.query.code ?? "");
      return reply.redirect("/integrations?connected=google");
    } catch (err) {
      return reply.redirect(`/integrations?error=${encodeURIComponent((err as Error).message)}`);
    }
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/api/integrations/mercadolivre/oauth/callback", async (req, reply) => {
    if (req.query.error) return reply.redirect(`/integrations?error=${encodeURIComponent(req.query.error)}`);
    if (!verifySession(req.query.state)?.sub.startsWith("oauth:")) return reply.code(400).send("state inválido");
    try {
      await mercadolivreExchangeCode(req.query.code ?? "");
      return reply.redirect("/integrations?connected=mercadolivre");
    } catch (err) {
      return reply.redirect(`/integrations?error=${encodeURIComponent((err as Error).message)}`);
    }
  });

  await app.register(async (base) => {
    base.addHook("preHandler", requireAuth);

    // ================= Rotas com escopo: super admin vê tudo, admin só os próprios dados =================
    base.get("/api/me/overview", async (req) => {
      const uid = scopeUserId(req.account);
      const tz = config.DEFAULT_TIMEZONE;
      const money = await one(
        `SELECT COALESCE(SUM(amount) FILTER (WHERE kind='expense' AND date_trunc('month', occurred_at AT TIME ZONE $2) = date_trunc('month', now() AT TIME ZONE $2)),0) AS expenses_month,
                COALESCE(SUM(amount) FILTER (WHERE kind='income' AND date_trunc('month', occurred_at AT TIME ZONE $2) = date_trunc('month', now() AT TIME ZONE $2)),0) AS income_month,
                COALESCE(SUM(amount) FILTER (WHERE kind='expense' AND date_trunc('month', occurred_at AT TIME ZONE $2) = date_trunc('month', (now() - interval '1 month') AT TIME ZONE $2)),0) AS expenses_prev
           FROM transactions WHERE ($1::uuid IS NULL OR user_id = $1)`,
        [uid, tz],
      );
      const counts = await one(
        `SELECT (SELECT COUNT(*) FROM reminders WHERE status = 'scheduled' AND ($1::uuid IS NULL OR user_id = $1)) AS reminders,
                (SELECT COUNT(*) FROM memories WHERE ($1::uuid IS NULL OR user_id = $1)) AS memories,
                (SELECT COALESCE(SUM(messages), 0) FROM usage_daily WHERE day = current_date AND ($1::uuid IS NULL OR user_id = $1)) AS messages_24h,
                (SELECT COUNT(*) FROM watches WHERE active AND ($1::uuid IS NULL OR user_id = $1)) AS watches`,
        [uid],
      );
      const byCategory = await many(
        `SELECT category, SUM(amount) AS total FROM transactions WHERE ($1::uuid IS NULL OR user_id = $1) AND kind = 'expense'
            AND date_trunc('month', occurred_at AT TIME ZONE $2) = date_trunc('month', now() AT TIME ZONE $2) GROUP BY category ORDER BY total DESC`,
        [uid, tz],
      );
      const nextReminders = await many(
        `SELECT id, intent, due_at, cron FROM reminders WHERE status = 'scheduled' AND ($1::uuid IS NULL OR user_id = $1) ORDER BY due_at ASC NULLS LAST LIMIT 5`,
        [uid],
      );
      const recent = await many(
        `SELECT id, kind, amount, category, description, merchant, occurred_at FROM transactions WHERE ($1::uuid IS NULL OR user_id = $1) ORDER BY occurred_at DESC LIMIT 6`,
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
        await query("UPDATE accounts SET password_hash = $2 WHERE id = $1", [a.id, hashPassword(req.body.password)]);
      }
      if (req.body.name) await query("UPDATE accounts SET name = $2 WHERE id = $1", [a.id, req.body.name.slice(0, 80)]);
      if (a.userId && (req.body.timezone || req.body.name)) {
        await query("UPDATE users SET timezone = COALESCE($2, timezone), name = COALESCE($3, name) WHERE id = $1", [a.userId, req.body.timezone ?? null, req.body.name ?? null]);
      }
      return { ok: true };
    });

    base.get("/api/me/profile", async (req) => {
      const user = req.account.userId ? await one("SELECT id, phone, name, status, timezone FROM users WHERE id = $1", [req.account.userId]) : null;
      return { account: { email: req.account.email, name: req.account.name, role: req.account.role, phone: req.account.phone, owner: req.account.owner }, user };
    });

    // ---------- Finanças ----------
    base.get<{ Querystring: { user?: string; month?: string } }>("/api/finance", async (req) => {
      const uid = scopeUserId(req.account) ?? (req.query.user || null);
      const tz = config.DEFAULT_TIMEZONE;
      const month = /^\d{4}-\d{2}$/.test(req.query.month ?? "") ? req.query.month! : new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).format(new Date());
      const where = `($1::uuid IS NULL OR t.user_id = $1) AND to_char(t.occurred_at AT TIME ZONE $2, 'YYYY-MM') = $3`;
      const totals = await one(
        `SELECT COALESCE(SUM(amount) FILTER (WHERE kind='expense'),0) AS expenses, COALESCE(SUM(amount) FILTER (WHERE kind='income'),0) AS income, COUNT(*) AS count FROM transactions t WHERE ${where}`,
        [uid, tz, month],
      );
      const byCategory = await many(
        `SELECT category, SUM(amount) AS total, COUNT(*) AS count FROM transactions t WHERE ${where} AND kind = 'expense' GROUP BY category ORDER BY total DESC`,
        [uid, tz, month],
      );
      const daily = await many(
        `SELECT to_char(t.occurred_at AT TIME ZONE $2, 'DD') AS day, SUM(amount) FILTER (WHERE kind='expense') AS expenses FROM transactions t WHERE ${where} GROUP BY 1 ORDER BY 1`,
        [uid, tz, month],
      );
      const months = await many(
        `SELECT to_char(t.occurred_at AT TIME ZONE $2, 'YYYY-MM') AS month, COALESCE(SUM(amount) FILTER (WHERE kind='expense'),0) AS expenses, COALESCE(SUM(amount) FILTER (WHERE kind='income'),0) AS income
           FROM transactions t WHERE ($1::uuid IS NULL OR t.user_id = $1) AND t.occurred_at > now() - interval '6 months' GROUP BY 1 ORDER BY 1`,
        [uid, tz],
      );
      const transactions = await many(
        `SELECT t.id, t.kind, t.amount, t.category, t.description, t.merchant, t.source, t.occurred_at, u.name AS user_name, u.phone
           FROM transactions t JOIN users u ON u.id = t.user_id WHERE ${where} ORDER BY t.occurred_at DESC LIMIT 300`,
        [uid, tz, month],
      );
      const [py, pm] = month.split("-").map(Number) as [number, number];
      const prevMonth = new Date(Date.UTC(py, pm - 2, 1)).toISOString().slice(0, 7);
      const prevByCategory = await many(
        `SELECT category, SUM(amount) AS total FROM transactions t WHERE ${where} AND kind = 'expense' GROUP BY category`,
        [uid, tz, prevMonth],
      );
      return { month, totals, byCategory, prevByCategory, daily, months, transactions };
    });

    base.post<{ Body: { kind: "expense" | "income"; amount: number | string; category: string; description?: string; date?: string; user?: string } }>("/api/finance", async (req, reply) => {
      const uid = scopeUserId(req.account) ?? req.body.user;
      if (!uid) return reply.code(400).send({ error: "Escolha a pessoa" });
      let amount: number;
      try {
        amount = parseAmount(req.body.amount);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      if (amount <= 0) return reply.code(400).send({ error: "Valor precisa ser maior que zero" });
      const when = req.body.date ? new Date(`${req.body.date}T12:00:00`) : new Date();
      return one(
        `INSERT INTO transactions (user_id, kind, amount, category, description, occurred_at, source) VALUES ($1,$2,$3,$4,$5,$6,'painel') RETURNING *`,
        [uid, req.body.kind === "income" ? "income" : "expense", amount, CATEGORIES.includes(req.body.category) ? req.body.category : "Outros", req.body.description ?? null, when],
      );
    });

    base.delete<{ Params: { id: string } }>("/api/finance/:id", async (req) => {
      const r = await query("DELETE FROM transactions WHERE id = $1 AND ($2::uuid IS NULL OR user_id = $2)", [req.params.id, scopeUserId(req.account)]);
      return { ok: (r.rowCount ?? 0) > 0 };
    });

    base.get("/api/finance/categories", async () => CATEGORIES);

    // ---------- Convites e contatos ----------
    base.get("/api/invites", async (req) => {
      const uid = scopeUserId(req.account);
      const isSuper = req.account.role === "superadmin";
      const rows = await many(
        `SELECT i.id, i.code, i.name, i.phone, i.email, i.status, i.sent_at, i.created_at, i.responded_at, i.expires_at,
                COALESCE(u.full_name, u.name, a.name, 'Equipe') AS inviter_name
           FROM invites i LEFT JOIN users u ON u.id = i.inviter_user_id LEFT JOIN accounts a ON a.id = i.inviter_account_id
          WHERE ($1::uuid IS NULL OR i.inviter_user_id = $1) ORDER BY i.created_at DESC LIMIT 300`,
        [uid],
      );
      const leaderboard = isSuper
        ? await many(
            `SELECT COALESCE(u.full_name, u.name, '+' || u.phone) AS name, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE i.status = 'accepted')::int AS accepted
               FROM invites i JOIN users u ON u.id = i.inviter_user_id GROUP BY 1 ORDER BY accepted DESC, total DESC LIMIT 20`,
          )
        : [];
      return { invites: rows.map((r) => ({ ...r, link: inviteLink(r.code) })), stats: await inviteStats(uid), leaderboard };
    });
    base.post<{ Body: { name?: string; phone?: string; email?: string } }>("/api/invites", async (req, reply) => {
      const a = req.account;
      if (a.role !== "superadmin" && !a.userId) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil antes de convidar." });
      try {
        const r = await createInvite({
          inviterUserId: a.role === "superadmin" ? (a.userId ?? null) : a.userId,
          inviterAccountId: a.owner ? null : a.id,
          name: req.body.name,
          phone: String(req.body.phone ?? ""),
          email: req.body.email,
        });
        if ("already" in r) return reply.code(409).send({ error: "Essa pessoa já é seu contato." });
        return { ...r.invite, link: inviteLink(r.invite.code) };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
    base.delete<{ Params: { id: string } }>("/api/invites/:id", async (req) => {
      const r = await query("UPDATE invites SET status = 'expired' WHERE id = $1 AND status = 'pending' AND ($2::uuid IS NULL OR inviter_user_id = $2)", [
        req.params.id,
        scopeUserId(req.account),
      ]);
      return { ok: (r.rowCount ?? 0) > 0 };
    });
    base.get("/api/contacts", async (req) => {
      const uid = req.account.userId;
      return uid ? listContacts(uid) : [];
    });

    // ---------- Acompanhamentos (o agente fica de olho e avisa sozinho) ----------
    base.get("/api/watches", async (req) => listWatches(scopeUserId(req.account)));
    base.delete<{ Params: { id: string } }>("/api/watches/:id", async (req) => ({ ok: await cancelWatch(req.params.id, scopeUserId(req.account)) }));

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

    // ---------- Mapa do time: agentes e com que frequência conversam ----------
    base.get("/api/graph", async (req) => {
      const uid = scopeUserId(req.account);
      const nodes = [
        { id: "cto", name: CTO.name, icon: CTO.icon, role: CTO.role, kind: "cto" },
        ...SPECIALISTS.map((s) => ({ id: s.id, name: s.name, icon: s.icon, role: s.role, kind: "specialist" })),
      ];
      const clients = await many(
        `SELECT ca.id, ca.slug, ca.name, ca.focus, ca.uses, COALESCE(u.full_name, u.name) AS owner FROM client_agents ca JOIN users u ON u.id = ca.user_id
          WHERE ca.active AND ($1::uuid IS NULL OR ca.user_id = $1) ORDER BY ca.uses DESC LIMIT 12`,
        [uid],
      );
      for (const c of clients) nodes.push({ id: `c_${c.slug}`, name: c.name, icon: "sparkle", role: `${c.focus}${uid ? "" : ` (de ${c.owner})`}`, kind: "client" } as any);
      const edges = await many(
        `SELECT p.agent AS "from", s.agent AS "to", COUNT(*)::int AS n FROM execution_steps s
           JOIN execution_steps p ON p.id = s.parent_id JOIN executions e ON e.id = s.execution_id
          WHERE s.type = 'llm' AND p.type = 'delegate' AND s.agent <> p.agent AND s.started_at > now() - interval '7 days'
            AND ($1::uuid IS NULL OR e.user_id = $1)
          GROUP BY 1, 2`,
        [uid],
      );
      const activity = await many(
        `SELECT s.agent, COUNT(*)::int AS n FROM execution_steps s JOIN executions e ON e.id = s.execution_id
          WHERE s.type = 'llm' AND s.started_at > now() - interval '7 days' AND ($1::uuid IS NULL OR e.user_id = $1) GROUP BY 1`,
        [uid],
      );
      return { nodes, edges, activity: Object.fromEntries(activity.map((a) => [a.agent, a.n])) };
    });

    // ---------- Memórias ----------
    base.get<{ Querystring: { user?: string } }>("/api/memories", async (req) =>
      many(
        `SELECT m.id, m.content, m.tags, m.created_at, u.name AS user_name FROM memories m JOIN users u ON u.id = m.user_id
          WHERE ($1::uuid IS NULL OR m.user_id = $1) ORDER BY m.created_at DESC LIMIT 300`,
        [scopeUserId(req.account) ?? (req.query.user || null)],
      ),
    );
    base.delete<{ Params: { id: string } }>("/api/memories/:id", async (req) => {
      await query("DELETE FROM memories WHERE id = $1 AND ($2::uuid IS NULL OR user_id = $2)", [req.params.id, scopeUserId(req.account)]);
      return { ok: true };
    });

    // ---------- Lembretes ----------
    base.get("/api/reminders", async (req) => listReminders(scopeUserId(req.account) ?? undefined));
    base.delete<{ Params: { id: string } }>("/api/reminders/:id", async (req) => ({ ok: await cancelReminder(req.params.id, scopeUserId(req.account) ?? undefined) }));

    // novo lembrete pelo painel (calendário): vai para a conversa mais recente da pessoa
    base.post<{ Body: { intent?: string; at?: string; user?: string } }>("/api/reminders", async (req, reply) => {
      const uid = scopeUserId(req.account) ?? req.body.user ?? req.account.userId;
      const intent = String(req.body.intent ?? "").trim();
      if (!uid) return reply.code(400).send({ error: "Escolha a pessoa" });
      if (!intent) return reply.code(400).send({ error: "Diga o que lembrar" });
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(req.body.at ?? "")) return reply.code(400).send({ error: "Data e hora inválidas" });
      const u = await one("SELECT id, timezone FROM users WHERE id = $1", [uid]);
      const conv = u && (await one("SELECT id FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1", [uid]));
      if (!conv) return reply.code(400).send({ error: "Essa pessoa ainda não conversou no WhatsApp" });
      const tz = u.timezone ?? config.DEFAULT_TIMEZONE;
      try {
        return await createReminder({ userId: uid, conversationId: conv.id, intent: `${intent} (criado pelo painel)`, dueAt: parseLocalDateTime(req.body.at!, tz), timezone: tz });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });

    base.patch<{ Params: { id: string }; Body: { at?: string } }>("/api/reminders/:id", async (req, reply) => {
      const at = req.body.at ? new Date(req.body.at) : null;
      if (!at || Number.isNaN(at.getTime())) return reply.code(400).send({ error: "Data inválida" });
      try {
        return { ok: await rescheduleReminder(req.params.id, at, scopeUserId(req.account) ?? undefined) };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });

    // ---------- Agenda (calendário): lembretes + Google Agenda conectado (só o dono vê) ----------
    base.get<{ Querystring: { from?: string; to?: string; user?: string } }>("/api/calendar", async (req, reply) => {
      const from = new Date(req.query.from ?? "");
      const to = new Date(req.query.to ?? "");
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > 100 * 86400_000)
        return reply.code(400).send({ error: "Período inválido" });
      const uid = scopeUserId(req.account) ?? (req.query.user || null);
      const events: any[] = (await reminderOccurrences(from, to, uid)).map((e) => ({ ...e, kind: "reminder" }));
      if (req.account.role === "superadmin" && !req.query.user && (await isConnected("google").catch(() => false))) {
        try {
          const params = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250" });
          const j = await googleApi(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
          for (const e of j.items ?? []) {
            const allDay = !e.start?.dateTime;
            events.push({
              id: `g:${e.id}`,
              kind: "google",
              title: e.summary ?? "(sem título)",
              start: allDay ? `${e.start.date}T00:00:00` : e.start.dateTime,
              end: allDay ? null : e.end?.dateTime ?? null,
              allDay,
              location: e.location ?? null,
              link: e.htmlLink ?? null,
            });
          }
        } catch {
          /* Google fora do ar: mostra só os lembretes */
        }
      }
      return { events };
    });

    // ---------- Arquivos gerados (gravações do navegador, prints) ----------
    base.get<{ Params: { id: string } }>("/api/media/:id", async (req, reply) => {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(404).send({ error: "não encontrado" });
      const f = await one("SELECT mimetype, file_name, data, user_id FROM media_files WHERE id = $1", [req.params.id]);
      const uid = scopeUserId(req.account);
      if (!f || (uid && f.user_id !== uid)) return reply.code(404).send({ error: "não encontrado" });
      reply.header("Content-Type", f.mimetype).header("Content-Disposition", `inline; filename="${f.file_name ?? "arquivo"}"`).header("Cache-Control", "private, max-age=3600");
      return reply.send(f.data);
    });

    base.get("/api/recordings", async (req) =>
      many(
        `SELECT f.id, f.kind, f.mimetype, f.size, f.created_at, f.execution_id, u.name AS user_name FROM media_files f LEFT JOIN users u ON u.id = f.user_id
          WHERE ($1::uuid IS NULL OR f.user_id = $1) ORDER BY f.created_at DESC LIMIT 100`,
        [scopeUserId(req.account)],
      ),
    );

  // ================= Só super admin =================
  await base.register(async (api) => {
    api.addHook("preHandler", requireSuper);

    // ---------- Contas do painel ----------
    api.get("/api/accounts", async () =>
      many(`SELECT a.id, a.email, a.name, a.role, a.status, a.phone, a.created_at, a.last_login_at, u.status AS whatsapp_status
              FROM accounts a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.status = 'pending' DESC, a.created_at DESC`),
    );
    api.patch<{ Params: { id: string }; Body: { status?: string; role?: string } }>("/api/accounts/:id", async (req, reply) => {
      const status = req.body.status && ["active", "pending", "disabled"].includes(req.body.status) ? req.body.status : null;
      const role = req.body.role && ["superadmin", "admin"].includes(req.body.role) ? req.body.role : null;
      const row = await one("UPDATE accounts SET status = COALESCE($2, status), role = COALESCE($3, role) WHERE id = $1 RETURNING *", [req.params.id, status, role]);
      if (!row) return reply.code(404).send({ error: "não encontrada" });
      // aprovar a conta libera o número no WhatsApp; desativar bloqueia
      if (row.user_id && status === "active") await query("UPDATE users SET status = 'active' WHERE id = $1 AND status = 'pending'", [row.user_id]);
      if (row.user_id && status === "disabled") await query("UPDATE users SET status = 'blocked' WHERE id = $1", [row.user_id]);
      return { ok: true };
    });
    api.delete<{ Params: { id: string } }>("/api/accounts/:id", async (req) => {
      await query("DELETE FROM accounts WHERE id = $1", [req.params.id]);
      return { ok: true };
    });
    api.post<{ Body: { name: string; email: string; password: string; phone?: string; role?: string } }>("/api/accounts", async (req, reply) => {
      const email = String(req.body.email ?? "").trim().toLowerCase();
      if (!email || String(req.body.password ?? "").length < 8) return reply.code(400).send({ error: "E-mail e senha (8+ caracteres) são obrigatórios" });
      if (await one("SELECT 1 FROM accounts WHERE email = $1", [email])) return reply.code(409).send({ error: "E-mail já cadastrado" });
      let userId: string | null = null;
      const phone = req.body.phone ? normalizePhone(req.body.phone) : null;
      if (phone) {
        const u = await one(
          `INSERT INTO users (phone, name, status) VALUES ($1, $2, 'active') ON CONFLICT (phone) DO UPDATE SET status = 'active' RETURNING id`,
          [phone, req.body.name ?? null],
        );
        userId = u.id;
      }
      return one(
        `INSERT INTO accounts (email, name, password_hash, role, status, user_id, phone) VALUES ($1,$2,$3,$4,'active',$5,$6) RETURNING id, email, name, role, status`,
        [email, req.body.name ?? null, hashPassword(req.body.password), req.body.role === "superadmin" ? "superadmin" : "admin", userId, phone],
      );
    });

    api.get("/api/overview", async () => {
      const stats = await one(`
        SELECT
          COUNT(*) FILTER (WHERE started_at > now() - interval '24 hours') AS executions_24h,
          COUNT(*) FILTER (WHERE started_at > now() - interval '24 hours' AND status = 'error') AS errors_24h,
          COALESCE(SUM(cost_usd) FILTER (WHERE started_at > now() - interval '24 hours'), 0) AS cost_24h,
          COALESCE(SUM(cost_usd) FILTER (WHERE started_at > date_trunc('month', now())), 0) AS cost_month,
          COALESCE(AVG(duration_ms) FILTER (WHERE started_at > now() - interval '24 hours' AND status = 'success'), 0) AS avg_ms_24h
        FROM executions`);
      const counts = await one(`
        SELECT (SELECT COUNT(*) FROM users WHERE status = 'active' AND phone <> 'playground') AS people,
               (SELECT COUNT(*) FROM users WHERE status = 'pending') AS pending_people,
               (SELECT COALESCE(SUM(messages), 0) FROM usage_daily WHERE day = current_date) AS messages_24h,
               (SELECT COUNT(*) FROM invites WHERE status = 'accepted') AS invites_accepted,
               (SELECT COUNT(*) FROM client_agents WHERE active) AS client_agents,
               (SELECT COUNT(*) FROM reminders WHERE status = 'scheduled') AS reminders`);
      const daily = await many(`
        SELECT to_char(d, 'YYYY-MM-DD') AS day,
               COUNT(e.id) AS executions,
               COUNT(e.id) FILTER (WHERE e.status = 'error') AS errors,
               COALESCE(SUM(e.cost_usd), 0) AS cost
          FROM generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d
          LEFT JOIN executions e ON date_trunc('day', e.started_at) = d
         GROUP BY d ORDER BY d`);
      const byAgent = await many(`
        SELECT agent, COUNT(*) FILTER (WHERE type = 'llm') AS llm_calls, COUNT(*) FILTER (WHERE type IN ('tool','delegate')) AS tool_calls,
               COALESCE(SUM(cost_usd), 0) AS cost
          FROM execution_steps WHERE started_at > now() - interval '7 days' GROUP BY agent ORDER BY cost DESC`);
      const ch = activeChannel();
      const wa = config.WHATSAPP_PROVIDER === "baileys" ? await one("SELECT status FROM wa_sessions WHERE id = $1", [SESSION_ID]) : null;
      const configured = wa ? wa.status === "connected" : (ch?.configured() ?? false);
      const pendingAccounts = await one("SELECT COUNT(*) AS n FROM accounts WHERE status = 'pending'");
      return {
        stats,
        counts: { ...counts, pending_accounts: pendingAccounts?.n ?? 0 },
        daily,
        byAgent,
        channel: { provider: config.WHATSAPP_PROVIDER, configured },
        openrouter: Boolean(config.OPENROUTER_API_KEY),
        redis: await redisInfo(),
        cache: await cacheStats(),
        retentionHours: config.MESSAGE_RETENTION_HOURS,
      };
    });

    // ---------- Execuções (logs) ----------
    api.get<{ Querystring: { status?: string; trigger?: string; before?: string; limit?: string; conversation?: string } }>("/api/executions", async (req) => {
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      return many(
        `SELECT e.id, e.trigger, e.status, e.input, e.output, e.error, e.tokens_in, e.tokens_out, e.cost_usd, e.started_at, e.duration_ms,
                u.name AS user_name, u.phone, e.conversation_id,
                (SELECT COUNT(*) FROM execution_steps s WHERE s.execution_id = e.id) AS steps,
                (SELECT array_agg(DISTINCT s.agent) FROM execution_steps s WHERE s.execution_id = e.id) AS agents
           FROM executions e LEFT JOIN users u ON u.id = e.user_id
          WHERE ($1::text IS NULL OR e.status = $1) AND ($2::text IS NULL OR e.trigger = $2)
            AND ($3::timestamptz IS NULL OR e.started_at < $3) AND ($5::uuid IS NULL OR e.conversation_id = $5)
          ORDER BY e.started_at DESC LIMIT $4`,
        [req.query.status || null, req.query.trigger || null, req.query.before || null, limit, req.query.conversation || null],
      );
    });

    api.get<{ Params: { id: string } }>("/api/executions/:id", async (req, reply) => {
      const exec = await one(
        `SELECT e.*, u.name AS user_name, u.phone FROM executions e LEFT JOIN users u ON u.id = e.user_id WHERE e.id = $1`,
        [req.params.id],
      );
      if (!exec) return reply.code(404).send({ error: "não encontrada" });
      const steps = await many("SELECT * FROM execution_steps WHERE execution_id = $1 ORDER BY id", [req.params.id]);
      return { ...exec, steps };
    });

    api.delete<{ Querystring: { older_than_days?: string } }>("/api/executions", async (req) => {
      const days = Math.max(1, Number(req.query.older_than_days ?? 30));
      const r = await query("DELETE FROM executions WHERE started_at < now() - make_interval(days => $1)", [days]);
      return { deleted: r.rowCount };
    });

    // ---------- Clientes ----------
    api.get("/api/clients", async () =>
      many(`SELECT u.id, u.phone, u.name, u.full_name, u.email, u.status, u.created_at, u.last_seen_at,
                   COALESCE(inv.full_name, inv.name) AS invited_by_name,
                   (SELECT COUNT(*)::int FROM invites i WHERE i.inviter_user_id = u.id) AS invites_sent,
                   (SELECT COUNT(*)::int FROM invites i WHERE i.inviter_user_id = u.id AND i.status = 'accepted') AS invites_accepted,
                   (SELECT COUNT(*)::int FROM contacts c WHERE c.user_id = u.id) AS contacts,
                   (SELECT COUNT(*)::int FROM client_agents ca WHERE ca.user_id = u.id AND ca.active) AS agents,
                   a.id AS account_id, a.email AS account_email, a.status AS account_status, a.role AS account_role
              FROM users u LEFT JOIN users inv ON inv.id = u.invited_by LEFT JOIN accounts a ON a.user_id = u.id
             WHERE u.phone <> 'playground' ORDER BY u.status = 'pending' DESC, u.created_at DESC LIMIT 500`),
    );
    api.post<{ Body: { full_name?: string; email?: string; phone?: string; notify?: boolean } }>("/api/clients", async (req, reply) => {
      const fullName = String(req.body.full_name ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
      const email = String(req.body.email ?? "").trim().toLowerCase();
      const phone = normalizePhone(req.body.phone ?? "");
      if (fullName.split(" ").length < 2) return reply.code(400).send({ error: "Informe nome e sobrenome" });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ error: "E-mail inválido" });
      if (phone.length < 12 || phone.length > 15) return reply.code(400).send({ error: "Telefone inválido: use DDD e número" });
      const exists = await one("SELECT id FROM users WHERE phone = ANY($1)", [phoneVariants(phone)]);
      if (exists) {
        const row = await one(
          "UPDATE users SET full_name = $2, email = $3, status = CASE WHEN status = 'blocked' THEN status ELSE 'active' END WHERE id = $1 RETURNING *",
          [exists.id, fullName, email],
        );
        return { client: row, updated: true };
      }
      const client = await one("INSERT INTO users (phone, name, full_name, email, status) VALUES ($1, $2, $2, $3, 'active') RETURNING *", [phone, fullName, email]);
      // convite já aceito: serve de link para a pessoa criar a senha do painel
      const code = randomBytes(6).toString("base64url").replace(/[-_]/g, "x").slice(0, 8).toUpperCase();
      await query(
        "INSERT INTO invites (code, inviter_account_id, name, phone, email, status, invitee_user_id, responded_at, sent_at) VALUES ($1, $2, $3, $4, $5, 'accepted', $6, now(), now())",
        [code, req.account.owner ? null : req.account.id, fullName, phone, email, client.id],
      );
      if (req.body.notify) {
        const { notifyUser } = await import("../../social.js");
        await notifyUser(
          client.id,
          `Oi, ${fullName.split(" ")[0]}! Você foi cadastrado no Planejai, um assistente aqui no WhatsApp para gastos, lembretes e pesquisas. ` +
            `Pode me mandar mensagem quando quiser. Para acessar o painel: ${inviteLink(code)}`,
        ).catch(() => {});
      }
      return { client, link: inviteLink(code) };
    });
    api.patch<{ Params: { id: string }; Body: { status?: string; full_name?: string; email?: string } }>("/api/clients/:id", async (req) =>
      one(
        `UPDATE users SET status = COALESCE($2, status), full_name = COALESCE($3, full_name), email = COALESCE($4, email) WHERE id = $1 RETURNING *`,
        [req.params.id, ["active", "pending", "blocked"].includes(req.body.status ?? "") ? req.body.status : null, req.body.full_name ?? null, req.body.email ?? null],
      ),
    );

    // ---------- Agentes de cada cliente (melhoria diária) ----------
    api.get("/api/client-agents", async () =>
      many(`SELECT ca.*, COALESCE(u.full_name, u.name, '+' || u.phone) AS owner FROM client_agents ca JOIN users u ON u.id = ca.user_id ORDER BY ca.active DESC, ca.uses DESC`),
    );
    api.patch<{ Params: { id: string }; Body: { active?: boolean; instructions?: string } }>("/api/client-agents/:id", async (req) =>
      one("UPDATE client_agents SET active = COALESCE($2, active), instructions = COALESCE($3, instructions), updated_at = now() WHERE id = $1 RETURNING *", [
        req.params.id,
        typeof req.body.active === "boolean" ? req.body.active : null,
        req.body.instructions ?? null,
      ]),
    );
    api.get("/api/topics", async () =>
      many(`SELECT t.topic, round(t.score::numeric, 1) AS score, t.days, t.last_at, COALESCE(u.full_name, u.name) AS owner FROM user_topics t JOIN users u ON u.id = t.user_id ORDER BY t.score DESC LIMIT 100`),
    );
    api.post<{ Body: { user?: string } }>("/api/improve/run", async (req) => (req.body?.user ? improveUser(req.body.user) : dailyImprovement()));

    // ---------- Pessoas ----------
    api.get("/api/people", async () =>
      many(`SELECT u.*, (SELECT COUNT(*) FROM memories m WHERE m.user_id = u.id) AS memories FROM users u WHERE u.phone <> $1 ORDER BY u.status = 'pending' DESC, u.last_seen_at DESC NULLS LAST`, [PLAYGROUND_PHONE]),
    );

    api.post<{ Body: { phone: string; name?: string } }>("/api/people", async (req) => {
      const phone = String(req.body.phone ?? "").replace(/\D/g, "");
      return one(
        `INSERT INTO users (phone, name, status) VALUES ($1, $2, 'active') ON CONFLICT (phone) DO UPDATE SET status = 'active', name = COALESCE(EXCLUDED.name, users.name) RETURNING *`,
        [phone, req.body.name ?? null],
      );
    });

    api.patch<{ Params: { id: string }; Body: { status?: string; name?: string; timezone?: string } }>("/api/people/:id", async (req) =>
      one(
        `UPDATE users SET status = COALESCE($2, status), name = COALESCE($3, name), timezone = COALESCE($4, timezone) WHERE id = $1 RETURNING *`,
        [req.params.id, req.body.status ?? null, req.body.name ?? null, req.body.timezone ?? null],
      ),
    );

    // ---------- Integrações ----------
    api.get("/api/integrations", async () => ({
      integrations: await listIntegrations(),
      googleRedirectUri: googleRedirectUri(),
    }));

    api.put<{ Params: { id: string }; Body: Record<string, string> }>("/api/integrations/:id", async (req, reply) => {
      const def = getDef(req.params.id);
      if (!def) return reply.code(404).send({ error: "integração desconhecida" });
      const creds: Record<string, string> = {};
      const current = await rawCredentials(def.id);
      for (const f of def.fields) {
        const v = req.body?.[f.key];
        // campo de senha vazio no formulário = manter o valor salvo
        if (v != null && v !== "") creds[f.key] = String(v).trim();
        else if (f.required && !current[f.key]) return reply.code(400).send({ error: `${f.label} é obrigatório` });
      }
      if (def.test) {
        try {
          const message = await def.test({ ...current, ...creds });
          await saveCredentials(def.id, creds);
          return { ok: true, message };
        } catch (err) {
          return reply.code(400).send({ error: (err as Error).message });
        }
      }
      await saveCredentials(def.id, creds);
      return { ok: true, message: def.oauth ? "Credenciais salvas. Agora clique em Conectar com Google." : "Salvo" };
    });

    api.post<{ Params: { id: string } }>("/api/integrations/:id/test", async (req, reply) => {
      const def = getDef(req.params.id);
      if (!def) return reply.code(404).send({ error: "integração desconhecida" });
      if (!(await isConnected(def.id))) return reply.code(400).send({ error: "Não conectada" });
      if (!def.test) return { ok: true, message: "Conectada (sem teste automático)" };
      try {
        return { ok: true, message: await def.test(await rawCredentials(def.id)) };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });

    api.patch<{ Params: { id: string }; Body: { enabled: boolean } }>("/api/integrations/:id", async (req) => {
      await setEnabled(req.params.id, Boolean(req.body.enabled));
      return { ok: true };
    });

    api.delete<{ Params: { id: string } }>("/api/integrations/:id", async (req) => {
      await disconnect(req.params.id);
      return { ok: true };
    });

    api.get("/api/integrations/mercadolivre/oauth/start", async () => {
      const state = signSession({ sub: `oauth:${randomBytes(8).toString("hex")}`, exp: Date.now() + 10 * 60_000 });
      return { url: await mercadolivreAuthUrl(state) };
    });

    api.get("/api/integrations/google/oauth/start", async () => {
      const state = signSession({ sub: `oauth:${randomBytes(8).toString("hex")}`, exp: Date.now() + 10 * 60_000 });
      return { url: await googleAuthUrl(state) };
    });

    // ---------- Time de agentes e modelos ----------
    api.get("/api/agents", async () => {
      const describe = async (id: string, name: string, icon: string, role: string, tools: typeof CTO_TOOLS) => ({
        id,
        name,
        icon,
        role,
        model: (await resolveModel(`agent:${id}`)).model,
        tools: await Promise.all(
          tools.map(async (t) => ({ name: t.name, description: t.description, integration: t.integration ?? null, available: !t.integration || (await isConnected(t.integration)) })),
        ),
      });
      return [
        await describe(CTO.id, CTO.name, CTO.icon, CTO.role, CTO_TOOLS),
        ...(await Promise.all(SPECIALISTS.map((s) => describe(s.id, s.name, s.icon, s.role, s.tools)))),
      ];
    });

    api.get("/api/models/routes", async () => listRoutes());
    api.put<{ Params: { task: string }; Body: { model: string; fallbacks?: string[]; temperature?: number | null; maxTokens?: number | null } }>(
      "/api/models/routes/:task",
      async (req, reply) => {
        if (!req.body.model) return reply.code(400).send({ error: "model é obrigatório" });
        await saveRoute(req.params.task, req.body);
        return { ok: true };
      },
    );
    api.delete<{ Params: { task: string } }>("/api/models/routes/:task", async (req) => {
      await resetRoute(req.params.task);
      return { ok: true };
    });
    api.get("/api/models/catalog", async (_req, reply) => {
      try {
        return await listModels();
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    });

    // ---------- WhatsApp embutido (Baileys) ----------
    api.get("/api/whatsapp", async () => {
      const session = await one("SELECT status, qr, pairing_code, phone, name, last_error, updated_at, heartbeat_at, last_message_at, COALESCE(heartbeat_at > now() - interval '60 seconds', false) AS listening FROM wa_sessions WHERE id = $1", [SESSION_ID]);
      return { provider: config.WHATSAPP_PROVIDER, session };
    });
    api.post<{ Body: { phone?: string } }>("/api/whatsapp/connect", async (req, reply) => {
      if (config.WHATSAPP_PROVIDER !== "baileys") return reply.code(400).send({ error: "WHATSAPP_PROVIDER não é baileys" });
      const phone = req.body?.phone?.replace(/\D/g, "");
      await query("UPDATE wa_sessions SET status = 'connecting', qr = NULL, pairing_code = NULL, last_error = NULL, updated_at = now() WHERE id = $1", [SESSION_ID]);
      await sendWaCommand({ action: "connect", phone: phone || undefined });
      return { ok: true };
    });
    api.post("/api/whatsapp/logout", async () => {
      await sendWaCommand({ action: "logout" });
      return { ok: true };
    });
    api.post("/api/whatsapp/restart", async () => {
      await sendWaCommand({ action: "restart" });
      return { ok: true };
    });

    // ---------- Configurações ----------
    api.get("/api/settings", async () => {
      const ch = activeChannel();
      const base = config.PUBLIC_URL.replace(/\/$/, "");
      return {
        settings: await getSettings(),
        channel: {
          provider: config.WHATSAPP_PROVIDER,
          configured: ch?.configured() ?? false,
          webhookUrl:
            config.WHATSAPP_PROVIDER === "baileys" || config.WHATSAPP_PROVIDER === "none"
              ? null
              : config.WHATSAPP_PROVIDER === "cloud"
              ? `${base}/webhooks/whatsapp`
              : `${base}/webhooks/evolution${config.WEBHOOK_SECRET ? "?secret=<WEBHOOK_SECRET>" : ""}`,
        },
        ownerPhones: config.OWNER_PHONES,
        allowUnknown: config.ALLOW_UNKNOWN_CONTACTS,
        openrouter: Boolean(config.OPENROUTER_API_KEY),
      };
    });
    api.put<{ Body: Record<string, unknown> }>("/api/settings", async (req, reply) => {
      try {
        return await saveSettings(req.body as any);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });

  });
  });
}
