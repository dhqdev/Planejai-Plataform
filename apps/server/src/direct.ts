import { normalizePhone } from "./accounts.js";
import { humanize } from "./agent/humanize.js";
import { redactSecrets } from "./agent/guard.js";
import type { InboundMessage } from "./channels/types.js";
import { many, one, query } from "./db/pool.js";
import { introduce } from "./errands.js";
import { isOwner, phoneVariants } from "./ingest.js";
import { QUEUES, getBoss } from "./queue/boss.js";
import { markSeen } from "./shortmem.js";
import { jidFor, notifyUser, outboundChannel } from "./social.js";
import { formatLocal } from "./time.js";
import { findOnWhatsApp } from "./whatsapp/rpc.js";

/**
 * Mensagem avulsa: "manda pro cliente (11 9...) a proposta amanhã às 8h". Vai para qualquer número, agora ou
 * agendada, como mensagem normal: sem convite de cadastro e sem virar contato. Convite só com invite_person.
 * - Só sai depois do "sim" da pessoa (send_whatsapp usa requireConfirmation).
 * - Quem recebe precisa saber de quem é: se o texto não traz o nome da pessoa, o servidor apresenta.
 * - Se a pessoa responder em até REPLY_WINDOW_H horas, a resposta volta para quem mandou (não vira cliente).
 */

export const MAX_SCHEDULED = 20;
export const MAX_PER_DAY = 30;
const REPLY_WINDOW_H = 72;

export interface DirectMessage {
  id: string;
  user_id: string;
  name: string | null;
  phone: string;
  jid: string | null;
  text: string;
  send_at: string;
  status: string;
  sent_at: string | null;
  error: string | null;
}

const firstName = (u: { full_name?: string | null; name?: string | null }) => (u.full_name || u.name || "").split(" ")[0] || null;

/** O texto que sai: limpo, e com a apresentação quando não diz de quem é. */
export function directText(message: string, sender: { full_name?: string | null; name?: string | null }) {
  const first = firstName(sender);
  const t = message.trim();
  const says = first && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t);
  return redactSecrets(humanize(says ? t : introduce(t, first))).slice(0, 3000);
}

export async function createDirect(opts: {
  user: { id: string; phone: string; name?: string | null; full_name?: string | null };
  phone: string;
  name?: string | null;
  message: string;
  sendAt?: Date | null;
  timezone: string;
}) {
  const phone = normalizePhone(opts.phone);
  if (phone.length < 12 || phone.length > 13) return { ok: false, error: `Telefone inválido: ${opts.phone}. Precisa do DDD.` };
  const variants = phoneVariants(phone);
  if (variants.some((v) => phoneVariants(opts.user.phone).includes(v))) return { ok: false, error: "Esse número é da própria pessoa." };
  if (isOwner(phone) && !isOwner(opts.user.phone)) return { ok: false, error: "Para falar com o dono do Planejai, use contact_owner." };
  const text = directText(opts.message, opts.user);
  if (!opts.message.trim()) return { ok: false, error: "Mensagem vazia" };
  const sendAt = opts.sendAt && opts.sendAt.getTime() > Date.now() + 30_000 ? opts.sendAt : null;
  if (sendAt && sendAt.getTime() > Date.now() + 90 * 86400_000) return { ok: false, error: "Dá para agendar até 90 dias à frente." };
  const counts = await one<{ scheduled: number; today: number }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'scheduled')::int AS scheduled,
            COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS today
       FROM direct_messages WHERE user_id = $1`,
    [opts.user.id],
  );
  if ((counts?.today ?? 0) >= MAX_PER_DAY) return { ok: false, error: "Limite de mensagens avulsas por dia atingido. Amanhã dá de novo." };
  if (sendAt && (counts?.scheduled ?? 0) >= MAX_SCHEDULED) return { ok: false, error: `Já são ${MAX_SCHEDULED} mensagens agendadas. Cancele alguma antes (direct_cancel).` };

  const row = await one<{ id: string }>(
    `INSERT INTO direct_messages (user_id, name, phone, text, send_at) VALUES ($1, $2, $3, $4, COALESCE($5, now())) RETURNING id`,
    [opts.user.id, opts.name?.trim().slice(0, 80) || null, phone, text, sendAt],
  );
  const id = row!.id;
  const who = opts.name ? `${opts.name} (+${phone})` : `+${phone}`;
  if (sendAt) {
    const boss = await getBoss();
    await boss.send(QUEUES.outbound, { type: "direct", directId: id }, { startAfter: sendAt, retryLimit: 2, retryDelay: 60, singletonKey: `direct:${id}` });
    return { ok: true, id, scheduled_for: formatLocal(sendAt, opts.timezone), to: who, message: text, tip: "Fica na Agenda do painel, onde dá para cancelar." };
  }
  const r = await sendDirect(id);
  return r.ok ? { ok: true, id, sent_to: who, message: text } : r;
}

/** Envia (na hora ou quando o agendamento vence). Agendada avisa quem pediu que saiu. */
export async function sendDirect(id: string, opts: { notify?: boolean } = {}) {
  const d = await one<DirectMessage>(
    "UPDATE direct_messages SET status = 'sending' WHERE id = $1 AND status = 'scheduled' RETURNING *",
    [id],
  );
  if (!d) return { ok: false, error: "Essa mensagem já foi enviada ou cancelada." };
  try {
    const exists = await findOnWhatsApp(phoneVariants(d.phone));
    if (exists === null) throw new Error(`O número +${d.phone} não tem WhatsApp.`);
    const channel = outboundChannel();
    const jid = exists ?? (await jidFor(d.phone, channel));
    await channel.sendText(jid, d.text);
    await query("UPDATE direct_messages SET status = 'sent', sent_at = now(), jid = $2, error = NULL WHERE id = $1", [id, jid]);
    if (opts.notify) await notifyUser(d.user_id, `Mandei para ${d.name ?? `+${d.phone}`} a mensagem que você agendou.`).catch(() => {});
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await query("UPDATE direct_messages SET status = 'failed', error = $2 WHERE id = $1", [id, msg.slice(0, 300)]);
    if (opts.notify) await notifyUser(d.user_id, `Não consegui mandar a mensagem agendada para ${d.name ?? `+${d.phone}`}: ${msg}`).catch(() => {});
    return { ok: false, error: msg, no_whatsapp: /não tem WhatsApp/.test(msg) };
  }
}

export async function listDirect(userId: string) {
  return many<DirectMessage>("SELECT * FROM direct_messages WHERE user_id = $1 AND status = 'scheduled' ORDER BY send_at LIMIT 30", [userId]);
}

export async function cancelDirect(userId: string, id: string) {
  const r = await one("UPDATE direct_messages SET status = 'cancelled' WHERE id::text = $1 AND user_id = $2 AND status = 'scheduled' RETURNING id", [id, userId]);
  return r ? { ok: true } : { ok: false, error: "Não achei essa mensagem agendada (já saiu ou foi cancelada)." };
}

/**
 * Resposta de quem recebeu uma mensagem avulsa: volta para quem mandou, como recado, e não vira cliente.
 * Quem já usa o Planejai segue o caminho normal (a conversa é com o assistente dele).
 */
export async function handleDirectReply(msg: InboundMessage): Promise<boolean> {
  if (!msg.phone || msg.kind === "reaction") return false;
  const variants = phoneVariants(msg.phone);
  if (isOwner(msg.phone)) return false;
  const member = await one("SELECT id FROM users WHERE phone = ANY($1) AND status = 'active'", [variants]);
  if (member) return false;
  const d = await one<DirectMessage & { full_name: string | null; uname: string | null; uphone: string }>(
    `SELECT d.*, u.full_name, u.name AS uname, u.phone AS uphone FROM direct_messages d JOIN users u ON u.id = d.user_id
      WHERE d.phone = ANY($1) AND d.status = 'sent' AND d.sent_at > now() - make_interval(hours => $2)
      ORDER BY d.sent_at DESC LIMIT 1`,
    [variants, REPLY_WINDOW_H],
  );
  if (!d) return false;
  if (msg.externalId && (await markSeen(`direct:${msg.channel}:${msg.externalId}`, 48 * 3600)) === false) return true;
  const who = d.name || msg.pushName || `+${d.phone}`;
  const body =
    msg.kind === "text" ? msg.text : msg.text?.trim() ? `${msg.text}\n[mandou ${msg.kind === "image" ? "uma foto" : "um arquivo"} também]` : `[mandou ${msg.kind === "audio" ? "um áudio" : msg.kind === "image" ? "uma foto" : "um arquivo"}]`;
  await notifyUser(d.user_id, `*${who}* respondeu:\n\n${String(body ?? "").slice(0, 2000)}`, undefined, { from: who });
  return true;
}

/** Resumo para a pessoa, usado no resultado das ferramentas. */
export function describeDirect(d: DirectMessage, tz: string) {
  return { id: d.id, to: d.name ? `${d.name} (+${d.phone})` : `+${d.phone}`, when: formatLocal(new Date(d.send_at), tz), text: d.text.slice(0, 200) };
}
