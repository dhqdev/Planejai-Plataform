import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { normalizePhone } from "../../../accounts.js";
import { many, one, query } from "../../../db/pool.js";
import { emitEvent } from "../../../events.js";
import { phoneVariants } from "../../../ingest.js";
import { withOutfits } from "../../../mascot.js";
import { eraseUserData } from "../../../privacy.js";
import { getSettings } from "../../../settings.js";
import { inviteLink } from "../../../social.js";
import { getTabs, saveTabs } from "../../../tabs.js";
import { isUuid, withLook } from "./shared.js";

/** Clientes e pessoas (só super admin): cadastro, exclusão (LGPD), custo de IA e uso de cada um. */
export function clientRoutes(api: FastifyInstance) {
  // ---------- Clientes ----------
  api.get("/api/clients", async () =>
    withOutfits(await many(`SELECT u.id, u.phone, u.name, u.full_name, u.email, u.status, u.created_at, u.last_seen_at,
                 COALESCE(inv.full_name, inv.name) AS invited_by_name,
                 (SELECT COUNT(*)::int FROM invites i WHERE i.inviter_user_id = u.id) AS invites_sent,
                 (SELECT COUNT(*)::int FROM invites i WHERE i.inviter_user_id = u.id AND i.status = 'accepted') AS invites_accepted,
                 (SELECT COUNT(*)::int FROM contacts c WHERE c.user_id = u.id) AS contacts,
                 (SELECT COUNT(*)::int FROM client_agents ca WHERE ca.user_id = u.id AND ca.active) AS agents,
                 a.id AS account_id, a.email AS account_email, a.status AS account_status, a.role AS account_role
            FROM users u LEFT JOIN users inv ON inv.id = u.invited_by LEFT JOIN accounts a ON a.user_id = u.id
           WHERE u.phone <> 'playground' ORDER BY u.status = 'pending' DESC, u.created_at DESC LIMIT 500`)),
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
    void emitEvent("user.created", { user_id: client.id, phone, name: fullName, email, source: "painel" });
    // convite já aceito: serve de link para a pessoa criar a senha do painel
    const code = randomBytes(6).toString("base64url").replace(/[-_]/g, "x").slice(0, 8).toUpperCase();
    await query(
      "INSERT INTO invites (code, inviter_account_id, name, phone, email, status, invitee_user_id, responded_at, sent_at) VALUES ($1, $2, $3, $4, $5, 'accepted', $6, now(), now())",
      [code, req.account.owner ? null : req.account.id, fullName, phone, email, client.id],
    );
    if (req.body.notify) {
      const { notifyUser } = await import("../../../social.js");
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

  // LGPD: apaga a pessoa e tudo dela (pedido de exclusão que chegou por outro meio)
  api.delete<{ Params: { id: string } }>("/api/clients/:id", async (req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "não encontrado" });
    const r = await eraseUserData(req.params.id);
    if (!r.ok) return reply.code(404).send({ error: "não encontrado" });
    return { ok: true };
  });

  // ---------- Custo de IA por cliente (usage_daily: fica mesmo depois que os logs somem) ----------
  api.get<{ Querystring: { days?: string } }>("/api/costs", async (req) => {
    const days = Math.min(180, Math.max(7, Number(req.query.days) || 30));
    const daily = await many(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(SUM(u.cost_usd), 0)::float AS cost, COALESCE(SUM(u.executions), 0)::int AS executions,
              COALESCE(SUM(u.messages), 0)::int AS messages
         FROM generate_series(current_date - ($1::int - 1), current_date, interval '1 day') d
         LEFT JOIN usage_daily u ON u.day = d::date GROUP BY d ORDER BY d`,
      [days],
    );
    const clients = await many(
      `SELECT u.user_id AS id, COALESCE(us.full_name, us.name, '+' || us.phone) AS name, us.phone,
              SUM(u.cost_usd)::float AS cost, SUM(u.executions)::int AS executions, SUM(u.messages)::int AS messages,
              SUM(u.tokens_in + u.tokens_out)::float AS tokens, SUM(u.tokens_in)::float AS tokens_in, SUM(u.tokens_out)::float AS tokens_out,
              (SELECT COALESCE(-SUM(g.delta), 0)::int FROM grain_ledger g WHERE g.user_id = u.user_id AND g.reason = 'uso' AND g.created_at > current_date - $1::int) AS grains_charged,
              COALESCE(SUM(u.cost_usd) FILTER (WHERE u.day > current_date - 7), 0)::float AS cost_7d,
              json_agg(json_build_object('day', to_char(u.day, 'YYYY-MM-DD'), 'cost', u.cost_usd::float) ORDER BY u.day) AS series
         FROM usage_daily u JOIN users us ON us.id = u.user_id
        WHERE u.day > current_date - $1::int
        GROUP BY u.user_id, us.full_name, us.name, us.phone
        HAVING SUM(u.cost_usd) > 0 OR SUM(u.messages) > 0
        ORDER BY cost DESC LIMIT 100`,
      [days],
    );
    const total = daily.reduce((a, d) => a + d.cost, 0);
    // grão = custo real em US$ x billingGrainsPerUsd; quantos tokens isso dá depende do modelo, então vai a média real do período
    const rate = Number((await getSettings()).billingGrainsPerUsd || 1000);
    const tokens = clients.reduce((a, c) => a + Number(c.tokens ?? 0), 0);
    const grains = total * rate;
    for (const c of clients) c.grains = Math.ceil(c.cost * rate - 1e-9);
    return {
      days,
      total,
      daily,
      clients,
      grains: { perUsd: rate, usdPerGrain: 1 / rate, tokens, total: Math.ceil(grains - 1e-9), tokensPerGrain: grains > 0 ? tokens / grains : null },
    };
  });

  // ---------- Acompanhamento de uso de cada cliente ----------
  api.get<{ Params: { id: string } }>("/api/clients/:id/usage", async (req, reply) => {
    const id = req.params.id;
    if (!isUuid(id)) return reply.code(404).send({ error: "não encontrado" });
    const totals = await one(
      `SELECT COUNT(*) FILTER (WHERE started_at > now() - interval '24 hours')::int AS executions_24h,
              COUNT(*) FILTER (WHERE started_at > now() - interval '7 days')::int AS executions_7d,
              COALESCE(SUM(cost_usd) FILTER (WHERE started_at > now() - interval '24 hours'), 0)::float AS cost_24h,
              COALESCE(SUM(cost_usd) FILTER (WHERE started_at > now() - interval '7 days'), 0)::float AS cost_7d,
              COUNT(*) FILTER (WHERE status = 'error' AND started_at > now() - interval '7 days')::int AS errors_7d,
              MAX(started_at) AS last_at,
              (SELECT COALESCE(SUM(cost_usd), 0)::float FROM usage_daily WHERE user_id = $1) AS cost_total,
              (SELECT COALESCE(SUM(tokens_in + tokens_out), 0)::float FROM usage_daily WHERE user_id = $1 AND day > current_date - 7) AS tokens_7d,
              (SELECT COALESCE(SUM(tokens_in + tokens_out), 0)::float FROM usage_daily WHERE user_id = $1) AS tokens_total,
              (SELECT COALESCE(-SUM(delta), 0)::int FROM grain_ledger WHERE user_id = $1 AND reason = 'uso' AND created_at > now() - interval '7 days') AS grains_7d,
              (SELECT COALESCE(-SUM(delta), 0)::int FROM grain_ledger WHERE user_id = $1 AND reason = 'uso') AS grains_used,
              (SELECT plan_grains + extra_grains FROM wallets WHERE user_id = $1) AS grains_balance
         FROM executions WHERE user_id = $1`,
      [id],
    );
    const daily = await many(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(u.messages, 0)::int AS messages,
              COALESCE(u.cost_usd, 0)::float AS cost
         FROM generate_series(current_date - 13, current_date, interval '1 day') d LEFT JOIN usage_daily u ON u.user_id = $1 AND u.day = d::date ORDER BY d`,
      [id],
    ).catch(() => []);
    const byAgent = await many(
      `SELECT s.agent, COUNT(*)::int AS calls, COALESCE(SUM(s.cost_usd), 0)::float AS cost, COALESCE(SUM(s.tokens_in + s.tokens_out), 0)::int AS tokens
         FROM execution_steps s JOIN executions e ON e.id = s.execution_id
        WHERE e.user_id = $1 AND s.type = 'llm' AND s.started_at > now() - interval '7 days' GROUP BY 1 ORDER BY calls DESC`,
      [id],
    ).catch(() => []);
    const tools = await many(
      `SELECT s.name, COUNT(*)::int AS n FROM execution_steps s JOIN executions e ON e.id = s.execution_id
        WHERE e.user_id = $1 AND s.type = 'tool' AND s.started_at > now() - interval '7 days' GROUP BY 1 ORDER BY n DESC LIMIT 8`,
      [id],
    ).catch(() => []);
    const agents = (await many("SELECT id, slug, name, persona, face, focus, uses, active, created_at FROM client_agents WHERE user_id = $1 ORDER BY created_at", [id])).map((a) =>
      withLook(a, id),
    );
    // decisão do dono (D1): assuntos, jeito de falar e notas dos agentes são da pessoa; o painel só mostra os do próprio dono
    const own = id === req.account.userId;
    const topics = own ? await many("SELECT topic, round(score::numeric, 1)::float AS score, days FROM user_topics WHERE user_id = $1 ORDER BY score DESC LIMIT 10", [id]) : [];
    const person = own ? await one("SELECT style_notes FROM users WHERE id = $1", [id]) : null;
    const notes = own ? await many("SELECT agent, note, user_note, updated_at FROM agent_notes WHERE user_id = $1 ORDER BY agent", [id]) : [];
    const money = await one(
      `SELECT COUNT(*)::int AS transactions, (SELECT COUNT(*)::int FROM budgets WHERE user_id = $1) AS budgets,
              (SELECT COUNT(*)::int FROM reminders WHERE user_id = $1 AND status = 'scheduled') AS reminders,
              (SELECT COUNT(*)::int FROM watches WHERE user_id = $1 AND status = 'active') AS watches,
              (SELECT COUNT(*)::int FROM memories WHERE user_id = $1) AS memories
         FROM transactions WHERE user_id = $1`,
      [id],
    ).catch(() => null);
    return { totals, daily, byAgent, tools, agents, topics, styleNotes: person?.style_notes ?? null, notes, private: !own, counts: money, tabs: await getTabs(id) };
  });
  api.put<{ Params: { id: string }; Body: { modules?: string[]; custom?: unknown[] } }>("/api/clients/:id/tabs", async (req) => {
    const cur = await getTabs(req.params.id);
    await saveTabs(req.params.id, { modules: req.body.modules ?? cur.modules, custom: (req.body.custom as any) ?? cur.custom });
    return getTabs(req.params.id);
  });
}
