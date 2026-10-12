import type { FastifyInstance } from "fastify";
import { activeChannel } from "../../../channels/index.js";
import { config } from "../../../config.js";
import { many, one, query } from "../../../db/pool.js";
import { outfitsOf } from "../../../mascot.js";
import { queueOverview, retryJob } from "../../../queue/boss.js";
import { cacheStats, redisInfo } from "../../../shortmem.js";
import { SESSION_ID } from "../../../whatsapp/session.js";
import { selfUserId } from "../../../sharing.js";
import { isUuid } from "./shared.js";

/** Execução com texto visível: do próprio dono ($10), do playground ou do sistema (sem pessoa). */
const OPEN = "(e.user_id IS NULL OR e.user_id = $10::uuid OR u.phone = 'playground')";

/** Operação (só super admin): visão geral, filas e logs de execução. */
export function executionRoutes(api: FastifyInstance) {
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

  // ---------- Filas de execução (modo fila, como no n8n) ----------
  api.get("/api/queues", async () => ({ ...(await queueOverview()), concurrency: config.WORKER_CONCURRENCY }));
  api.post<{ Params: { name: string; id: string } }>("/api/queues/:name/:id/retry", async (req, reply) => {
    try {
      await retryJob(req.params.name, req.params.id);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // ---------- Execuções (logs) ----------
  // Privacidade: o texto (o que a pessoa escreveu, o que o time respondeu, entradas e saídas das ferramentas) só aparece
  // nas execuções do próprio dono, do playground e do sistema. As dos clientes mostram só métrica: modelo, custo, tempo,
  // ferramentas e erro. Vale como content_purged para a tela, com private = true para ela explicar o porquê.
  // filtros: status, gatilho, pessoa, agente, período (horas), busca no texto e paginação por data (before)
  api.get<{ Querystring: { status?: string; trigger?: string; before?: string; limit?: string; conversation?: string; user?: string; agent?: string; since?: string; q?: string } }>("/api/executions", async (req) => {
    const self = await selfUserId(req.account);
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const since = Number(req.query.since ?? 0);
    const q = String(req.query.q ?? "").trim().slice(0, 100);
    return many(
      `SELECT e.id, e.trigger, e.status, CASE WHEN ${OPEN} THEN left(e.input, 400) END AS input, CASE WHEN ${OPEN} THEN left(e.output, 400) END AS output,
              (e.content_purged OR NOT ${OPEN}) AS content_purged, NOT ${OPEN} AS private, left(e.error, 400) AS error,
              e.tokens_in, e.tokens_out, e.cost_usd, e.started_at, e.duration_ms,
              e.user_id, u.name AS user_name, u.phone, e.conversation_id, c.channel,
              (SELECT COUNT(*) FROM execution_steps s WHERE s.execution_id = e.id) AS steps,
              (SELECT COUNT(*) FROM execution_steps s WHERE s.execution_id = e.id AND s.type = 'llm')::int AS llm_calls,
              (SELECT COUNT(*) FROM execution_steps s WHERE s.execution_id = e.id AND s.type IN ('tool', 'delegate'))::int AS tool_calls,
              (SELECT s.model FROM execution_steps s WHERE s.execution_id = e.id AND s.model IS NOT NULL GROUP BY s.model ORDER BY COUNT(*) DESC LIMIT 1) AS model,
              (SELECT array_agg(DISTINCT s.agent) FROM execution_steps s WHERE s.execution_id = e.id) AS agents
         FROM executions e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN conversations c ON c.id = e.conversation_id
        WHERE ($1::text IS NULL OR e.status = $1) AND ($2::text IS NULL OR e.trigger = $2)
          AND ($3::timestamptz IS NULL OR e.started_at < $3) AND ($5::uuid IS NULL OR e.conversation_id = $5)
          AND ($6::uuid IS NULL OR e.user_id = $6)
          AND ($7::text IS NULL OR EXISTS (SELECT 1 FROM execution_steps s WHERE s.execution_id = e.id AND s.agent = $7))
          AND ($8::int = 0 OR e.started_at > now() - make_interval(hours => $8))
          AND ($9::text IS NULL OR (${OPEN} AND (e.input ILIKE '%' || $9 || '%' OR e.output ILIKE '%' || $9 || '%')) OR e.error ILIKE '%' || $9 || '%' OR u.name ILIKE '%' || $9 || '%' OR u.phone LIKE '%' || $9 || '%')
        ORDER BY e.started_at DESC LIMIT $4`,
      [req.query.status || null, req.query.trigger || null, req.query.before || null, limit, req.query.conversation || null,
        req.query.user || null, req.query.agent || null, Number.isFinite(since) ? Math.max(0, Math.min(Math.round(since), 24 * 365)) : 0, q ? q.replace(/[%_\\]/g, "\\$&") : null,
        self],
    );
  });

  // Resumo do topo da tela (últimas N horas) e as opções dos filtros (pessoas e agentes que aparecem nos logs)
  api.get<{ Querystring: { since?: string } }>("/api/executions/summary", async (req) => {
    const hours = Math.max(1, Math.min(Number(req.query.since ?? 24) || 24, 24 * 365));
    const kpis = await one(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
              COUNT(*) FILTER (WHERE status = 'partial')::int AS partial,
              COUNT(*) FILTER (WHERE status = 'running')::int AS running,
              COALESCE(AVG(duration_ms) FILTER (WHERE status <> 'running'), 0)::int AS avg_ms,
              COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0)::int AS p95_ms,
              COALESCE(SUM(cost_usd), 0)::float AS cost_usd,
              COALESCE(SUM(tokens_in + tokens_out), 0)::bigint AS tokens
         FROM executions WHERE started_at > now() - make_interval(hours => $1)`,
      [hours],
    );
    const people = await many(
      `SELECT u.id, u.name, u.phone, COUNT(*)::int AS n FROM executions e JOIN users u ON u.id = e.user_id
        WHERE e.started_at > now() - interval '30 days' GROUP BY u.id ORDER BY n DESC LIMIT 50`,
    );
    const agents = await many(
      `SELECT s.agent, COUNT(DISTINCT s.execution_id)::int AS n FROM execution_steps s
        WHERE s.started_at > now() - interval '30 days' GROUP BY s.agent ORDER BY n DESC LIMIT 30`,
    );
    return { hours, ...kpis, tokens: Number(kpis?.tokens ?? 0), people, agents };
  });

  // Botão Parar: o worker que roda a execução vê o pedido em até 2 s, cancela o que estiver em andamento e avisa a pessoa
  api.post<{ Params: { id: string } }>("/api/executions/:id/stop", async (req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "não encontrada" });
    const { requestStop } = await import("../../../agent/stop.js");
    if (!(await requestStop(req.params.id))) return reply.code(409).send({ error: "Essa execução já terminou." });
    return { ok: true };
  });

  api.get<{ Params: { id: string } }>("/api/executions/:id", async (req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "não encontrada" });
    const exec = await one(
      `SELECT e.*, u.name AS user_name, u.phone, c.channel FROM executions e LEFT JOIN users u ON u.id = e.user_id
         LEFT JOIN conversations c ON c.id = e.conversation_id WHERE e.id = $1`,
      [req.params.id],
    );
    if (!exec) return reply.code(404).send({ error: "não encontrada" });
    const open = !exec.user_id || exec.user_id === (await selfUserId(req.account)) || exec.phone === "playground";
    const steps = await many(
      open
        ? "SELECT * FROM execution_steps WHERE execution_id = $1 ORDER BY id"
        : "SELECT id, execution_id, parent_id, agent, type, name, model, status, error, tokens_in, tokens_out, cost_usd, started_at, duration_ms FROM execution_steps WHERE execution_id = $1 ORDER BY id",
      [req.params.id],
    );
    if (!open) Object.assign(exec, { input: null, output: null, content_purged: true, private: true });
    // agentes criados para a pessoa (c_<slug>): nome e carinha para a linha do tempo
    const clientAgents = exec.user_id
      ? await many("SELECT 'c_' || slug AS id, name, persona, face FROM client_agents WHERE user_id = $1", [exec.user_id])
      : [];
    // roupinha do Mochi da pessoa: é o avatar dela na linha do tempo
    const outfit = exec.user_id ? ((await outfitsOf([exec.user_id])).get(exec.user_id) ?? null) : null;
    return { ...exec, outfit, steps, client_agents: clientAgents };
  });

  api.delete<{ Querystring: { older_than_days?: string } }>("/api/executions", async (req) => {
    const days = Math.max(1, Number(req.query.older_than_days ?? 30));
    const r = await query("DELETE FROM executions WHERE started_at < now() - make_interval(days => $1)", [days]);
    return { deleted: r.rowCount };
  });
}
