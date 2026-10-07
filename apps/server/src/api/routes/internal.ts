import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hashPassword, normalizePhone } from "../../accounts.js";
import { CATEGORIES, guessCategory, parseAmount } from "../../agent/tools/finance.js";
import { config } from "../../config.js";
import { safeEqual } from "../../crypto.js";
import { many, one, query } from "../../db/pool.js";
import { emitEvent, internalKey } from "../../events.js";
import { phoneVariants } from "../../ingest.js";
import { QUEUES, getBoss } from "../../queue/boss.js";
import { inviteLink } from "../../social.js";
import { connections } from "../../telegram.js";

/**
 * API interna para o n8n (e outras automações do dono). Autenticação: cabeçalho X-Planejai-Key
 * (ou Authorization: Bearer) com a chave mostrada em Integrações > n8n.
 *
 * Tudo que manda mensagem vai para a fila "outbound.send" e sai pelo worker (é ele que segura o WhatsApp).
 */

function keyOk(req: FastifyRequest) {
  const h = String(req.headers["x-planejai-key"] ?? "") || String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  return Boolean(h) && safeEqual(h, internalKey());
}

async function findUser(q: { phone?: string; user_id?: string; email?: string }) {
  if (q.user_id && /^[0-9a-f-]{36}$/i.test(q.user_id)) return one("SELECT * FROM users WHERE id = $1", [q.user_id]);
  if (q.phone) return one("SELECT * FROM users WHERE phone = ANY($1) ORDER BY status = 'active' DESC LIMIT 1", [phoneVariants(normalizePhone(q.phone))]);
  if (q.email) {
    const email = q.email.trim().toLowerCase();
    return one(
      "SELECT u.* FROM users u LEFT JOIN accounts a ON a.user_id = u.id WHERE lower(u.email) = $1 OR lower(a.email) = $1 LIMIT 1",
      [email],
    );
  }
  return null;
}

const bad = (reply: FastifyReply, error: string, code = 400) => reply.code(code).send({ ok: false, error });

export interface OutboundJob {
  type: "send" | "agent";
  userId?: string | null;
  phone?: string | null;
  channel?: "whatsapp" | "telegram" | "auto";
  text?: string;
  media?: { kind?: "image" | "video" | "document"; url?: string; base64?: string; mimetype?: string; caption?: string; fileName?: string };
  instruction?: string;
}

export async function registerInternalRoutes(app: FastifyInstance) {
  await app.register(async (api) => {
    api.addHook("preHandler", async (req, reply) => {
      if (!keyOk(req)) return reply.code(401).send({ ok: false, error: "chave inválida (X-Planejai-Key)" });
    });

    api.get("/api/internal/ping", async () => ({ ok: true, app: "planejai", public_url: config.PUBLIC_URL }));

    // ---------- Pessoas e contas ----------
    api.get<{ Querystring: { phone?: string; email?: string; user_id?: string } }>("/api/internal/users", async (req, reply) => {
      const u = await findUser(req.query);
      if (!u) return reply.code(404).send({ ok: false, exists: false });
      const account = await one("SELECT id, email, status FROM accounts WHERE user_id = $1 LIMIT 1", [u.id]);
      return { ok: true, exists: true, user: { id: u.id, phone: u.phone, name: u.full_name ?? u.name, email: u.email, status: u.status }, account, connections: await connections(u.id) };
    });

    // cria (ou reativa) a pessoa; com email + password cria também o login do painel
    api.post<{ Body: { name?: string; phone?: string; email?: string; password?: string } }>("/api/internal/users", async (req, reply) => {
      const phone = normalizePhone(req.body?.phone ?? "");
      if (phone.length < 12 || phone.length > 15) return bad(reply, "phone inválido: use DDD e número (ex.: 5519999999999)");
      const name = String(req.body.name ?? "").trim().replace(/\s+/g, " ").slice(0, 120) || null;
      const email = req.body.email ? String(req.body.email).trim().toLowerCase() : null;
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(reply, "email inválido");
      const existing = await findUser({ phone });
      const user = existing
        ? await one(
            "UPDATE users SET status = CASE WHEN status = 'blocked' THEN status ELSE 'active' END, full_name = COALESCE($2, full_name), name = COALESCE(name, $2), email = COALESCE($3, email) WHERE id = $1 RETURNING *",
            [existing.id, name, email],
          )
        : await one("INSERT INTO users (phone, name, full_name, email, status) VALUES ($1, $2, $2, $3, 'active') RETURNING *", [phone, name, email]);
      let accountId: string | null = null;
      if (email && req.body.password) {
        if (String(req.body.password).length < 8) return bad(reply, "password precisa de 8+ caracteres");
        const acc = await one(
          `INSERT INTO accounts (email, name, password_hash, role, status, user_id, phone) VALUES ($1, $2, $3, 'admin', 'active', $4, $5)
           ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active', user_id = EXCLUDED.user_id, phone = EXCLUDED.phone
           RETURNING id`,
          [email, name, hashPassword(String(req.body.password)), user.id, user.phone],
        );
        accountId = acc.id;
      }
      // link para criar a senha do painel (quando não veio senha)
      let link: string | null = null;
      if (!accountId) {
        const code = randomBytes(6).toString("base64url").replace(/[-_]/g, "x").slice(0, 8).toUpperCase();
        await query(
          "INSERT INTO invites (code, name, phone, email, status, invitee_user_id, responded_at, sent_at) VALUES ($1, $2, $3, $4, 'accepted', $5, now(), now())",
          [code, name, user.phone, email, user.id],
        );
        link = inviteLink(code);
      }
      if (!existing) void emitEvent("user.created", { user_id: user.id, phone: user.phone, name, email, source: "api" });
      return { ok: true, created: !existing, user: { id: user.id, phone: user.phone, name: user.full_name ?? user.name, email: user.email, status: user.status }, account_id: accountId, link };
    });

    // troca senha, nome ou status (active / blocked)
    api.patch<{ Body: { phone?: string; email?: string; user_id?: string; password?: string; name?: string; status?: string } }>("/api/internal/users", async (req, reply) => {
      const b = req.body ?? {};
      if (b.password != null && String(b.password).length < 8) return bad(reply, "password precisa de 8+ caracteres");
      if (b.status && !["active", "blocked"].includes(b.status)) return bad(reply, "status: active ou blocked");
      const u = await findUser(b);
      const acc = b.email ? await one("SELECT * FROM accounts WHERE lower(email) = $1", [b.email.trim().toLowerCase()]) : u ? await one("SELECT * FROM accounts WHERE user_id = $1", [u.id]) : null;
      if (!u && !acc) return bad(reply, "pessoa não encontrada", 404);
      if (b.password) {
        if (!acc) return bad(reply, "essa pessoa ainda não tem login no painel (crie com POST /api/internal/users com email e password)", 404);
        await query("UPDATE accounts SET password_hash = $2 WHERE id = $1", [acc.id, hashPassword(String(b.password))]);
      }
      if (u && (b.name || b.status)) {
        await query("UPDATE users SET full_name = COALESCE($2, full_name), status = COALESCE($3, status) WHERE id = $1", [u.id, b.name ?? null, b.status ?? null]);
      }
      if (acc && b.status) await query("UPDATE accounts SET status = $2 WHERE id = $1", [acc.id, b.status === "blocked" ? "disabled" : "active"]);
      return { ok: true, user_id: u?.id ?? acc?.user_id ?? null, account_id: acc?.id ?? null };
    });

    // ---------- Mensagens ----------
    // texto e/ou mídia (imagem, vídeo, PDF) para a pessoa, no canal onde ela conversa (ou no WhatsApp se ainda não tiver)
    api.post<{
      Body: {
        phone?: string;
        user_id?: string;
        channel?: "whatsapp" | "telegram" | "auto";
        text?: string;
        media_url?: string;
        media_base64?: string;
        mimetype?: string;
        kind?: "image" | "video" | "document";
        caption?: string;
        file_name?: string;
      };
    }>("/api/internal/send", async (req, reply) => {
      const b = req.body ?? {};
      if (!b.text && !b.media_url && !b.media_base64) return bad(reply, "mande text e/ou media_url / media_base64");
      const u = await findUser(b);
      if (!u && !b.phone) return bad(reply, "pessoa não encontrada (mande phone)", 404);
      if (u?.status === "blocked") return bad(reply, "pessoa bloqueada", 409);
      const base64 = b.media_base64?.replace(/^data:[^;]+;base64,/, "");
      const kind = b.kind ?? (b.mimetype?.startsWith("video/") ? "video" : b.mimetype && !b.mimetype.startsWith("image/") ? "document" : "image");
      const job: OutboundJob = {
        type: "send",
        userId: u?.id ?? null,
        phone: u ? u.phone : normalizePhone(b.phone!),
        channel: b.channel ?? "auto",
        text: b.text,
        media: b.media_url || base64 ? { kind, url: b.media_url, base64, mimetype: b.mimetype, caption: b.caption, fileName: b.file_name } : undefined,
      };
      const id = await (await getBoss()).send(QUEUES.outbound, job, { retryLimit: 2, retryDelay: 20 });
      return { ok: true, queued: true, job_id: id, user_id: u?.id ?? null };
    });

    // o assistente escreve a mensagem do jeito dele (ex.: "avise que o pagamento foi aprovado e dê as boas-vindas")
    api.post<{ Body: { phone?: string; user_id?: string; instruction?: string } }>("/api/internal/agent", async (req, reply) => {
      const b = req.body ?? {};
      if (!b.instruction?.trim()) return bad(reply, "mande instruction");
      const u = await findUser(b);
      if (!u) return bad(reply, "pessoa não encontrada", 404);
      if (u.status !== "active") return bad(reply, `pessoa ${u.status}`, 409);
      const job: OutboundJob = { type: "agent", userId: u.id, instruction: String(b.instruction).slice(0, 4000) };
      const id = await (await getBoss()).send(QUEUES.outbound, job, { retryLimit: 1 });
      return { ok: true, queued: true, job_id: id };
    });

    // ---------- Dados ----------
    api.post<{ Body: { phone?: string; user_id?: string; kind?: string; amount?: number | string; category?: string; description?: string; date?: string; external_ref?: string } }>(
      "/api/internal/transactions",
      async (req, reply) => {
        const b = req.body ?? {};
        const u = await findUser(b);
        if (!u) return bad(reply, "pessoa não encontrada", 404);
        let amount: number;
        try {
          amount = parseAmount(b.amount);
        } catch (err) {
          return bad(reply, (err as Error).message);
        }
        if (amount <= 0) return bad(reply, "amount precisa ser maior que zero");
        const kind = b.kind === "income" ? "income" : "expense";
        const category = b.category && CATEGORIES.includes(b.category) ? b.category : (guessCategory(b.description ?? "") ?? (kind === "income" ? "Salário" : "Outros"));
        const when = b.date ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(b.date) ? `${b.date}T12:00:00` : b.date) : new Date();
        if (Number.isNaN(when.getTime())) return bad(reply, "date inválida (AAAA-MM-DD)");
        const row = await one(
          `INSERT INTO transactions (user_id, kind, amount, category, description, occurred_at, source, external_ref) VALUES ($1,$2,$3,$4,$5,$6,'automacao',$7)
           ON CONFLICT (user_id, external_ref) WHERE external_ref IS NOT NULL DO NOTHING RETURNING *`,
          [u.id, kind, amount, category, b.description ?? null, when, b.external_ref ?? null],
        );
        if (!row) return { ok: true, duplicate: true };
        void emitEvent("transaction.created", { user_id: u.id, id: row.id, kind, amount, category, description: row.description, source: "automacao" });
        return { ok: true, transaction: row };
      },
    );

    api.get<{ Querystring: { phone?: string; user_id?: string; month?: string } }>("/api/internal/finance", async (req, reply) => {
      const u = await findUser(req.query);
      if (!u) return bad(reply, "pessoa não encontrada", 404);
      const month = /^\d{4}-\d{2}$/.test(req.query.month ?? "") ? req.query.month! : new Date().toISOString().slice(0, 7);
      const rows = await many(
        `SELECT kind, category, SUM(amount)::float AS total, COUNT(*)::int AS count FROM transactions
          WHERE user_id = $1 AND to_char(occurred_at, 'YYYY-MM') = $2 GROUP BY 1, 2 ORDER BY 3 DESC`,
        [u.id, month],
      );
      const sum = (k: string) => rows.filter((r) => r.kind === k).reduce((a, r) => a + r.total, 0);
      return { ok: true, month, income: sum("income"), expenses: sum("expense"), by_category: rows.filter((r) => r.kind === "expense") };
    });
  });
}

/** Worker: envia o que a API interna enfileirou. */
export async function runOutboundJob(job: OutboundJob) {
  const { conversationOf, jidFor, outboundChannel } = await import("../../social.js");
  const { channels } = await import("../../channels/index.js");
  const { pushShort } = await import("../../shortmem.js");
  if (job.type === "agent") {
    const u = await one("SELECT * FROM users WHERE id = $1", [job.userId]);
    if (!u) return;
    const { conv } = await conversationOf(u.id, u.phone);
    const { processConversation } = await import("../../agent/orchestrator.js");
    await processConversation(conv.id, {
      trigger: "reminder",
      event: `Uma automação do dono (n8n) pediu para você falar com a pessoa agora: ${job.instruction}. Escreva a mensagem para a pessoa, no seu jeito.`,
    });
    return;
  }
  let channel;
  let to: string;
  let convId: string | null = null;
  const u = job.userId ? await one("SELECT * FROM users WHERE id = $1", [job.userId]) : null;
  const tg = u && job.channel !== "whatsapp" ? await one("SELECT external_id FROM channel_links WHERE user_id = $1 AND channel = 'telegram'", [u.id]) : null;
  if (u && job.channel === "telegram") {
    if (!tg) throw new Error("essa pessoa não conectou o Telegram");
    channel = channels.telegram!;
    to = tg.external_id;
  } else if (u && job.channel !== "whatsapp") {
    const r = await conversationOf(u.id, u.phone);
    channel = r.channel;
    to = r.conv.remote_jid;
    convId = r.conv.id;
  } else {
    channel = outboundChannel();
    to = await jidFor(job.phone!, channel);
  }
  if (job.text) await channel.sendText(to, job.text);
  if (job.media) await channel.sendImage(to, job.media);
  // o assistente fica sabendo do que foi mandado em nome dele
  if (convId) await pushShort(convId, [{ id: Date.now(), role: "assistant", text: `${job.text ?? ""}${job.media ? `\n[${job.media.kind === "document" ? "arquivo" : "mídia"} enviada por automação]` : ""}`.trim(), ts: Date.now() }]);
}
