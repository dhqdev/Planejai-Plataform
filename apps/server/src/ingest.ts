import type { InboundMessage } from "./channels/types.js";
import { config } from "./config.js";
import { one, query } from "./db/pool.js";
import { QUEUES, getBoss } from "./queue/boss.js";

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

  const inserted = await one(
    `INSERT INTO messages (conversation_id, role, content, external_id, media, meta, created_at)
     VALUES ($1, 'user', $2, $3, $4, $5, $6)
     ON CONFLICT (conversation_id, external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING id`,
    [conv.id, msg.text, msg.externalId, msg.media ?? null, { kind: msg.kind, quoted: msg.quoted ?? null, fileName: msg.media?.fileName ?? null }, msg.timestamp],
  );
  if (!inserted) return { queued: false, reason: "duplicada" };
  if (user.status !== "active") return { queued: false, reason: `contato ${user.status}` };

  const boss = await getBoss();
  // Fila com policy "short": no máximo 1 job aguardando por conversa. Mensagens que chegam
  // dentro da janela entram no mesmo processamento, como alguém que lê tudo antes de responder.
  await boss.send(QUEUES.process, { conversationId: conv.id }, { singletonKey: conv.id, startAfter: config.MESSAGE_DEBOUNCE_SECONDS, retryLimit: 1 });
  return { queued: true };
}
