import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { processConversation } from "../../agent/orchestrator.js";
import { CTO, CTO_TOOLS, SPECIALISTS } from "../../agent/team.js";
import { activeChannel, PlaygroundChannel } from "../../channels/index.js";
import { config } from "../../config.js";
import { signSession, verifySession } from "../../crypto.js";
import { many, one, query } from "../../db/pool.js";
import { googleAuthUrl, googleExchangeCode, googleRedirectUri } from "../../integrations/google.js";
import { mercadolivreAuthUrl, mercadolivreExchangeCode } from "../../integrations/mercadolivre.js";
import { disconnect, getDef, isConnected, listIntegrations, rawCredentials, saveCredentials, setEnabled } from "../../integrations/registry.js";
import { listModels } from "../../llm/openrouter.js";
import { listRoutes, resetRoute, resolveModel, saveRoute } from "../../llm/router.js";
import { cancelReminder, listReminders } from "../../reminders.js";
import { getSettings, saveSettings } from "../../settings.js";
import { upsertConversation } from "../../ingest.js";
import { SESSION_ID, sendWaCommand } from "../../whatsapp/session.js";
import { hashPassword, normalizePhone, scopeUserId, verifyPassword } from "../../accounts.js";
import { CATEGORIES, parseAmount } from "../../agent/tools/finance.js";
import { redisInfo, clearShort } from "../../shortmem.js";
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
                (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
                  WHERE m.created_at > now() - interval '24 hours' AND ($1::uuid IS NULL OR c.user_id = $1)) AS messages_24h`,
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
      return { month, totals, byCategory, daily, months, transactions };
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

    // ---------- Conversas ----------
    base.get("/api/conversations", async (req) =>
      many(
        `SELECT c.id, c.channel, c.remote_jid, c.updated_at, c.summary, u.id AS user_id, u.name, u.phone, u.status,
                (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_message,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
           FROM conversations c JOIN users u ON u.id = c.user_id
          WHERE ($1::uuid IS NULL OR c.user_id = $1) ORDER BY c.updated_at DESC LIMIT 200`,
        [scopeUserId(req.account)],
      ),
    );

    base.get<{ Params: { id: string }; Querystring: { before?: string } }>("/api/conversations/:id/messages", async (req, reply) => {
      const conv = await one("SELECT user_id FROM conversations WHERE id = $1", [req.params.id]);
      const uid = scopeUserId(req.account);
      if (!conv || (uid && conv.user_id !== uid)) return reply.code(404).send({ error: "não encontrada" });
      return (
        await many(
          `SELECT id, role, content, external_id, media - 'base64' AS media, meta - 'doc_text' AS meta, created_at FROM messages
            WHERE conversation_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT 100`,
          [req.params.id, req.query.before ?? null],
        )
      ).reverse();
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
               (SELECT COUNT(*) FROM messages WHERE created_at > now() - interval '24 hours') AS messages_24h,
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
      const describe = async (id: string, name: string, emoji: string, role: string, tools: typeof CTO_TOOLS) => ({
        id,
        name,
        emoji,
        role,
        model: (await resolveModel(`agent:${id}`)).model,
        tools: await Promise.all(
          tools.map(async (t) => ({ name: t.name, description: t.description, integration: t.integration ?? null, available: !t.integration || (await isConnected(t.integration)) })),
        ),
      });
      return [
        await describe(CTO.id, CTO.name, CTO.emoji, CTO.role, CTO_TOOLS),
        ...(await Promise.all(SPECIALISTS.map((s) => describe(s.id, s.name, s.emoji, s.role, s.tools)))),
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

    // ---------- Playground: conversar com o agente pelo dashboard ----------
    api.post<{ Body: { text?: string; image?: { base64: string; mimetype: string }; file?: { base64: string; mimetype: string; fileName?: string }; reset?: boolean } }>("/api/playground", async (req) => {
      const user = await one(
        `INSERT INTO users (phone, name, status) VALUES ($1, 'Playground', 'active') ON CONFLICT (phone) DO UPDATE SET status = 'active' RETURNING *`,
        [PLAYGROUND_PHONE],
      );
      const conv = await upsertConversation(user.id, "playground", "playground");
      if (req.body.reset) {
        await query("DELETE FROM messages WHERE conversation_id = $1", [conv.id]);
        await clearShort(conv.id);
        await query("UPDATE conversations SET summary = NULL, summary_until = 0 WHERE id = $1", [conv.id]);
        return { ok: true };
      }
      const externalId = `pg-in-${Date.now()}`;
      const file: { base64: string; mimetype: string; fileName?: string } | undefined = req.body.file ?? req.body.image;
      const mt = file?.mimetype ?? "";
      const kind = !file ? "text" : mt.startsWith("image/") ? "image" : mt.startsWith("audio/") ? "audio" : mt.startsWith("video/") ? "video" : "document";
      await query(
        `INSERT INTO messages (conversation_id, role, content, external_id, media, meta) VALUES ($1, 'user', $2, $3, $4, $5)`,
        [conv.id, req.body.text ?? "", externalId, file ?? null, { kind, fileName: file?.fileName ?? null }],
      );
      const channel = new PlaygroundChannel();
      const r = await processConversation(conv.id, { trigger: "playground", channel });
      return {
        executionId: r.executionId,
        sent: channel.sent.map((s) =>
          s.type === "image" ? { type: "image", kind: s.image?.kind ?? "image", src: s.image?.base64 ? `data:${s.image.mimetype ?? "image/png"};base64,${s.image.base64}` : s.image?.url, caption: s.image?.caption } : s,
        ),
      };
    });

    api.get("/api/playground/history", async () => {
      const conv = await one(`SELECT c.id FROM conversations c WHERE c.channel = 'playground' AND c.remote_jid = 'playground'`);
      if (!conv) return [];
      return many(`SELECT id, role, content, meta, created_at FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 60`, [conv.id]).then((r) => r.reverse());
    });

  });
  });
}
