import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { processConversation } from "../../agent/orchestrator.js";
import { CTO, CTO_TOOLS, SPECIALISTS } from "../../agent/team.js";
import { activeChannel, PlaygroundChannel } from "../../channels/index.js";
import { config } from "../../config.js";
import { signSession, verifySession } from "../../crypto.js";
import { many, one, query } from "../../db/pool.js";
import { googleAuthUrl, googleExchangeCode, googleRedirectUri } from "../../integrations/google.js";
import { disconnect, getDef, isConnected, listIntegrations, rawCredentials, saveCredentials, setEnabled } from "../../integrations/registry.js";
import { listModels } from "../../llm/openrouter.js";
import { listRoutes, resetRoute, resolveModel, saveRoute } from "../../llm/router.js";
import { cancelReminder, listReminders } from "../../reminders.js";
import { getSettings, saveSettings } from "../../settings.js";
import { upsertConversation } from "../../ingest.js";
import { requireAuth } from "../server.js";

const PLAYGROUND_PHONE = "playground";

export async function registerDashboardRoutes(app: FastifyInstance) {
  // Callback do OAuth do Google vem do navegador sem cookie de API garantido: valida pelo state assinado.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/api/integrations/google/oauth/callback", async (req, reply) => {
    if (req.query.error) return reply.redirect(`/integrations?error=${encodeURIComponent(req.query.error)}`);
    if (!verifySession(req.query.state)) return reply.code(400).send("state inválido");
    try {
      await googleExchangeCode(req.query.code ?? "");
      return reply.redirect("/integrations?connected=google");
    } catch (err) {
      return reply.redirect(`/integrations?error=${encodeURIComponent((err as Error).message)}`);
    }
  });

  await app.register(async (api) => {
    api.addHook("preHandler", requireAuth);

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
      return { stats, counts, daily, byAgent, channel: { provider: config.WHATSAPP_PROVIDER, configured: ch?.configured() ?? false }, openrouter: Boolean(config.OPENROUTER_API_KEY) };
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

    // ---------- Conversas ----------
    api.get("/api/conversations", async () =>
      many(`
        SELECT c.id, c.channel, c.remote_jid, c.updated_at, c.summary, u.id AS user_id, u.name, u.phone, u.status,
               (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_message,
               (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
          FROM conversations c JOIN users u ON u.id = c.user_id ORDER BY c.updated_at DESC LIMIT 200`),
    );

    api.get<{ Params: { id: string }; Querystring: { before?: string } }>("/api/conversations/:id/messages", async (req) =>
      (
        await many(
          `SELECT id, role, content, external_id, media - 'base64' AS media, meta, created_at FROM messages
            WHERE conversation_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT 100`,
          [req.params.id, req.query.before ?? null],
        )
      ).reverse(),
    );

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

    api.get<{ Params: { id: string } }>("/api/people/:id/memories", async (req) =>
      many("SELECT id, content, tags, created_at FROM memories WHERE user_id = $1 ORDER BY created_at DESC", [req.params.id]),
    );

    api.delete<{ Params: { id: string } }>("/api/memories/:id", async (req) => {
      await query("DELETE FROM memories WHERE id = $1", [req.params.id]);
      return { ok: true };
    });

    api.get<{ Params: { id: string } }>("/api/people/:id/finance", async (req) => ({
      transactions: await many("SELECT * FROM transactions WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT 100", [req.params.id]),
      byCategory: await many(
        `SELECT category, SUM(amount) AS total FROM transactions WHERE user_id = $1 AND kind = 'expense' AND occurred_at > date_trunc('month', now()) GROUP BY category ORDER BY total DESC`,
        [req.params.id],
      ),
    }));

    // ---------- Lembretes ----------
    api.get("/api/reminders", async () => listReminders());
    api.delete<{ Params: { id: string } }>("/api/reminders/:id", async (req) => ({ ok: await cancelReminder(req.params.id) }));

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
            config.WHATSAPP_PROVIDER === "cloud"
              ? `${base}/webhooks/whatsapp`
              : `${base}/webhooks/evolution${config.WEBHOOK_SECRET ? "?secret=<WEBHOOK_SECRET>" : ""}`,
        },
        ownerPhones: config.OWNER_PHONES,
        allowUnknown: config.ALLOW_UNKNOWN_CONTACTS,
        openrouter: Boolean(config.OPENROUTER_API_KEY),
      };
    });
    api.put<{ Body: Record<string, unknown> }>("/api/settings", async (req) => saveSettings(req.body as any));

    // ---------- Playground: conversar com o agente pelo dashboard ----------
    api.post<{ Body: { text?: string; image?: { base64: string; mimetype: string }; reset?: boolean } }>("/api/playground", async (req) => {
      const user = await one(
        `INSERT INTO users (phone, name, status) VALUES ($1, 'Playground', 'active') ON CONFLICT (phone) DO UPDATE SET status = 'active' RETURNING *`,
        [PLAYGROUND_PHONE],
      );
      const conv = await upsertConversation(user.id, "playground", "playground");
      if (req.body.reset) {
        await query("DELETE FROM messages WHERE conversation_id = $1", [conv.id]);
        await query("UPDATE conversations SET summary = NULL, summary_until = 0 WHERE id = $1", [conv.id]);
        return { ok: true };
      }
      const externalId = `pg-in-${Date.now()}`;
      await query(
        `INSERT INTO messages (conversation_id, role, content, external_id, media, meta) VALUES ($1, 'user', $2, $3, $4, $5)`,
        [conv.id, req.body.text ?? "", externalId, req.body.image ?? null, { kind: req.body.image ? "image" : "text" }],
      );
      const channel = new PlaygroundChannel();
      const r = await processConversation(conv.id, { trigger: "playground", channel });
      return {
        executionId: r.executionId,
        sent: channel.sent.map((s) =>
          s.type === "image" ? { type: "image", src: s.image?.base64 ? `data:${s.image.mimetype ?? "image/png"};base64,${s.image.base64}` : s.image?.url, caption: s.image?.caption } : s,
        ),
      };
    });

    api.get("/api/playground/history", async () => {
      const conv = await one(`SELECT c.id FROM conversations c WHERE c.channel = 'playground' AND c.remote_jid = 'playground'`);
      if (!conv) return [];
      return many(`SELECT id, role, content, meta, created_at FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 60`, [conv.id]).then((r) => r.reverse());
    });

  });
}
