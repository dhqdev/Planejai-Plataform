import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { appJid, saveAppMessage, toMp3 } from "../../../channels/app.js";
import type { InboundKind } from "../../../channels/types.js";
import { config } from "../../../config.js";
import { many, one, query } from "../../../db/pool.js";
import { ingest } from "../../../ingest.js";
import { selfUserId } from "../../../sharing.js";
import { financeMonthOf, monthSql, monthStartOf } from "../../../finance-month.js";

/** Arquivo mandado pelo chat do app: até 15 MB (o mesmo teto que o WhatsApp aceita bem para foto e documento). */
const MAX_UPLOAD = 15 * 1024 * 1024;

const kindOf = (mimetype: string): InboundKind =>
  mimetype.startsWith("image/") ? "image" : mimetype.startsWith("audio/") ? "audio" : mimetype.startsWith("video/") ? "video" : "document";

const view = (m: any) => ({
  id: Number(m.id),
  role: m.role,
  text: m.text,
  media: m.media ? { ...m.media, url: m.has_data ? `/api/chat/media/${m.id}` : null } : null,
  reaction: m.reaction,
  cards: m.cards ?? undefined,
  at: m.created_at,
});

/**
 * Chat do app (aba Início no celular): a pessoa conversa com o próprio time pelo painel, com o mesmo motor,
 * as mesmas ferramentas e o mesmo "sim" do WhatsApp. Cada um só vê e escreve na própria conversa (selfUserId).
 */
export function chatRoutes(base: FastifyInstance) {
  base.get<{ Querystring: { after?: string; before?: string } }>("/api/chat", async (req) => {
    const uid = await selfUserId(req.account);
    const user = uid ? await one("SELECT id, name, full_name, status, timezone FROM users WHERE id = $1", [uid]) : null;
    if (!user) return { ready: false, reason: "Ligue seu WhatsApp ao perfil para conversar com o time por aqui.", messages: [] };
    const after = Number(req.query.after) || 0;
    const before = Number(req.query.before) || 0;
    const cols = "id, role, text, media, cards, reaction, created_at, data IS NOT NULL AS has_data";
    const rows = after
      ? await many(`SELECT ${cols} FROM app_chat WHERE user_id = $1 AND id > $2 ORDER BY id LIMIT 100`, [uid, after])
      : (await many(`SELECT ${cols} FROM app_chat WHERE user_id = $1 AND ($2 = 0 OR id < $2) ORDER BY id DESC LIMIT 60`, [uid, before])).reverse();
    const state = await one(
      `SELECT (SELECT typing_kind FROM app_chat_state WHERE user_id = $1 AND typing_until > now()) AS typing,
              EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
                       WHERE c.user_id = $1 AND c.channel = 'app' AND m.role = 'user' AND NOT m.processed) AS working`,
      [uid],
    );
    // reações às mensagens que já estavam na tela (o assistente reage depois que a mensagem chegou)
    const reactions = after
      ? await many("SELECT id, reaction FROM app_chat WHERE user_id = $1 AND role = 'user' AND reaction IS NOT NULL AND id <= $2 ORDER BY id DESC LIMIT 20", [uid, after])
      : [];
    return {
      ready: user.status === "active",
      reason: user.status === "active" ? undefined : "Sua conta ainda não está ativa.",
      messages: rows.map(view),
      reactions: reactions.map((r) => ({ id: Number(r.id), reaction: r.reaction })),
      typing: state?.typing ?? null,
      working: Boolean(state?.working),
      more: !after && rows.length === 60,
      hello: after || before ? undefined : await hello(uid!, user),
    };
  });

  base.post<{ Body: { text?: string; media?: { base64?: string; mimetype?: string; fileName?: string; seconds?: number } } }>("/api/chat", async (req, reply) => {
    const uid = await selfUserId(req.account);
    const user = uid ? await one("SELECT id, phone, name, status FROM users WHERE id = $1", [uid]) : null;
    if (!user) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil para conversar com o time por aqui." });
    if (user.status !== "active") return reply.code(403).send({ error: "Sua conta ainda não está ativa." });
    const text = String(req.body?.text ?? "").trim().slice(0, 4000);
    let media = req.body?.media?.base64 ? { ...req.body.media } : null;
    if (!text && !media) return reply.code(400).send({ error: "Mensagem vazia" });
    if (media) {
      media.mimetype = String(media.mimetype ?? "application/octet-stream").slice(0, 120);
      media.fileName = media.fileName ? String(media.fileName).replace(/[\\/\r\n"]/g, "").slice(0, 120) : undefined;
      if (Buffer.byteLength(media.base64!, "base64") > MAX_UPLOAD) return reply.code(413).send({ error: "Arquivo grande demais (até 15 MB)" });
      // gravação do Chrome (WebM) vira MP3: o transcritor não lê WebM
      if (media.mimetype.startsWith("audio/") && /webm/.test(media.mimetype)) {
        const mp3 = await toMp3(media.base64!, "webm");
        if (mp3) media = { ...media, base64: mp3, mimetype: "audio/mpeg" };
      }
    }
    const kind: InboundKind = media ? kindOf(media.mimetype!) : "text";
    const externalId = `app-in-${randomUUID()}`;
    const saved = await saveAppMessage(user.id, {
      role: "user",
      text: text || null,
      media: media ? { kind, mimetype: media.mimetype, fileName: media.fileName ?? null, seconds: Number(media.seconds) || null } : null,
      data: media?.base64 ?? null,
      externalId,
    });
    const r = await ingest({
      channel: "app",
      remoteJid: appJid(user.id),
      phone: user.phone,
      pushName: user.name ?? undefined,
      externalId,
      kind,
      text,
      media: media ? { mimetype: media.mimetype!, base64: media.base64, fileName: media.fileName } : undefined,
      timestamp: new Date(),
      raw: null,
    });
    const row = await one("SELECT id, role, text, media, cards, reaction, created_at, data IS NOT NULL AS has_data FROM app_chat WHERE id = $1", [saved!.id]);
    return { message: view(row), queued: r.queued, reason: r.reason };
  });

  base.get<{ Params: { id: string } }>("/api/chat/media/:id", async (req, reply) => {
    const uid = await selfUserId(req.account);
    if (!uid || !/^\d+$/.test(req.params.id)) return reply.code(404).send({ error: "Não encontrado" });
    const m = await one("SELECT media, data FROM app_chat WHERE id = $1 AND user_id = $2 AND data IS NOT NULL", [req.params.id, uid]);
    if (!m) return reply.code(404).send({ error: "Não encontrado" });
    const type = String(m.media?.mimetype ?? "application/octet-stream");
    const name = String(m.media?.fileName ?? "arquivo").replace(/[^\w.\- ]/g, "_");
    reply
      .header("Content-Type", type)
      .header("Content-Disposition", `${/^(image|audio|video)\//.test(type) ? "inline" : "attachment"}; filename="${name}"`)
      .header("Cache-Control", "private, max-age=86400");
    return reply.send(Buffer.from(m.data, "base64"));
  });

  /** Limpa a conversa da tela (o que ele sabe da pessoa, os gastos e a agenda ficam). */
  base.delete("/api/chat", async (req) => {
    const uid = await selfUserId(req.account);
    if (uid) await query("DELETE FROM app_chat WHERE user_id = $1", [uid]);
    return { ok: true };
  });
}

/**
 * O que o time conta ao abrir o chat (sem IA): compromissos de hoje, gasto do mês, o que está de olho e
 * recado esperando resposta. A tela transforma isso nas primeiras mensagens de cada agente.
 */
async function hello(uid: string, user: { name?: string | null; full_name?: string | null; timezone?: string | null }) {
  const tz = user.timezone ?? config.DEFAULT_TIMEZONE;
  const start = await monthStartOf(uid);
  const [today, money, watches, errands] = await Promise.all([
    many(
      `SELECT COALESCE(title, intent) AS title, COALESCE(event_at, due_at) AS at FROM reminders
        WHERE user_id = $1 AND status = 'scheduled'
          AND (COALESCE(event_at, due_at) AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date
          AND COALESCE(event_at, due_at) > now() - interval '1 hour'
        ORDER BY 2 LIMIT 3`,
      [uid, tz],
    ),
    one(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE ${monthSql("occurred_at", "$2", start)} = $3), 0) AS month,
              COALESCE(SUM(amount) FILTER (WHERE (occurred_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date), 0) AS today
         FROM transactions WHERE user_id = $1 AND kind = 'expense'`,
      [uid, tz, financeMonthOf(new Date(), tz, start)],
    ),
    many("SELECT query FROM watches WHERE user_id = $1 AND active ORDER BY created_at DESC LIMIT 2", [uid]),
    one("SELECT COUNT(*)::int AS n FROM errands WHERE user_id = $1 AND status = 'asking' AND NOT hidden", [uid]),
  ]);
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(new Date()));
  return {
    name: (user.full_name || user.name || "").split(" ")[0] || null,
    hour,
    today: today.map((t) => ({ title: String(t.title).slice(0, 80), at: t.at })),
    spent_month: String(money?.month ?? "0"),
    spent_today: String(money?.today ?? "0"),
    watches: watches.map((w) => String(w.query).slice(0, 60)),
    errands_waiting: errands?.n ?? 0,
  };
}
