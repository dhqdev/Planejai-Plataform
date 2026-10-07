import type { InboundMessage } from "./channels/types.js";
import { config } from "./config.js";
import { one, query } from "./db/pool.js";
import { QUEUES, getBoss } from "./queue/boss.js";
import { getSettings } from "./settings.js";
import { countInWindow, markSeen } from "./shortmem.js";
import { handleInviteReply } from "./social.js";
import { getChannel } from "./channels/index.js";

/** Celulares do Brasil chegam no WhatsApp com ou sem o nono dígito (55 19 9xxxx-xxxx vs 55 19 xxxx-xxxx). */
export function phoneVariants(phone: string): string[] {
  const m = phone.match(/^55(\d{2})(9?)(\d{8})$/);
  if (!m) return [phone];
  return [`55${m[1]}9${m[3]}`, `55${m[1]}${m[3]}`];
}

export function isOwner(phone: string) {
  const variants = phoneVariants(phone);
  return config.OWNER_PHONES.some((o) => phoneVariants(o).some((v) => variants.includes(v)));
}

export async function upsertUser(phone: string, name?: string) {
  const status = isOwner(phone) || config.ALLOW_UNKNOWN_CONTACTS ? "active" : "pending";
  return one(
    `INSERT INTO users (phone, name, status, last_seen_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (phone) DO UPDATE SET name = COALESCE(users.name, EXCLUDED.name), last_seen_at = now(),
       status = CASE WHEN users.status = 'pending' AND EXCLUDED.status = 'active' THEN 'active' ELSE users.status END
     RETURNING *`,
    [phone, name ?? null, status],
  );
}

export async function upsertConversation(userId: string, channel: string, remoteJid: string) {
  return one(
    `INSERT INTO conversations (user_id, channel, remote_jid) VALUES ($1, $2, $3)
     ON CONFLICT (channel, remote_jid) DO UPDATE SET updated_at = now() RETURNING *`,
    [userId, channel, remoteJid],
  );
}

/** Guarda a mensagem recebida e agenda o processamento (com debounce, para juntar mensagens seguidas). */
export async function ingest(msg: InboundMessage): Promise<{ queued: boolean; reason?: string }> {
  if (!msg.phone) return { queued: false, reason: "sem telefone" };
  const user = await upsertUser(msg.phone, msg.pushName);
  const conv = await upsertConversation(user.id, msg.channel, msg.remoteJid);

  // Reação da pessoa: registra na mensagem reagida, não dispara resposta
  if (msg.kind === "reaction") {
    if (msg.reactionTo) {
      await query(
        "UPDATE messages SET meta = meta || jsonb_build_object('user_reaction', $3::text) WHERE conversation_id = $1 AND external_id = $2",
        [conv.id, msg.reactionTo, msg.text],
      );
    }
    return { queued: false, reason: "reação" };
  }

  // Mensagem repetida (o WhatsApp reentrega às vezes): com o Redis, o banco nem é tocado
  if (msg.externalId && (await markSeen(`${msg.channel}:${msg.externalId}`, 48 * 3600)) === false) return { queued: false, reason: "duplicada" };

  // Resposta a convite (SIM/NÃO) é tratada aqui mesmo, sem IA
  if (msg.kind === "text") {
    const channel = getChannel(msg.channel);
    if (await handleInviteReply({ user, text: msg.text, channel, remoteJid: msg.remoteJid })) return { queued: false, reason: "convite" };
  }
  if (user.status !== "active") return { queued: false, reason: `contato ${user.status}` };

  const inserted = await one(
    `INSERT INTO messages (conversation_id, role, content, external_id, media, meta, created_at)
     VALUES ($1, 'user', $2, $3, $4, $5, $6)
     ON CONFLICT (conversation_id, external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING id`,
    [conv.id, msg.text, msg.externalId, msg.media ?? null, { kind: msg.kind, quoted: msg.quoted ?? null, fileName: msg.media?.fileName ?? null }, msg.timestamp],
  );
  if (!inserted) return { queued: false, reason: "duplicada" };
  await query(
    "INSERT INTO usage_daily (user_id, day, messages) VALUES ($1, current_date, 1) ON CONFLICT (user_id, day) DO UPDATE SET messages = usage_daily.messages + 1",
    [user.id],
  );

  const settings = await getSettings();
  // Ritmo: quem manda mensagem demais por minuto (spam, robô, loop) recebe no máximo uma resposta por minuto,
  // com tudo junto. Nada se perde: as mensagens ficam guardadas e entram no próximo processamento.
  let delay = config.MESSAGE_DEBOUNCE_SECONDS;
  let throttled = false;
  if (!isOwner(msg.phone)) {
    const n =
      (await countInWindow(`conv:${conv.id}`, 60)) ??
      (await one("SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1 AND role = 'user' AND created_at > now() - interval '1 minute'", [conv.id])).n;
    if (n > settings.rateLimitPerMinute) {
      delay = Math.max(delay, 60);
      throttled = true;
    }
  }

  const boss = await getBoss();
  // Fila com policy "short": no máximo 1 job aguardando por conversa. Mensagens que chegam
  // dentro da janela entram no mesmo processamento, como alguém que lê tudo antes de responder.
  // O job expira um pouco depois do tempo máximo de execução, para nunca ficar preso.
  await boss.send(
    QUEUES.process,
    { conversationId: conv.id },
    { singletonKey: conv.id, startAfter: delay, retryLimit: 1, expireInSeconds: Math.ceil(settings.maxExecutionMinutes * 60) + 120 },
  );
  return { queued: true, reason: throttled ? "ritmo alto: resposta segurada" : undefined };
}
