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
  media_kind?: string | null;
  media_name?: string | null;
}

/** Foto ou documento que vai junto com a mensagem (guardado na linha até sair). */
export interface DirectAttachment {
  kind: "image" | "document";
  base64: string;
  mimetype: string;
  fileName?: string;
}

/** Até onde o texto vai como legenda da foto/arquivo; mais longo sai em balão separado antes. */
const CAPTION_MAX = 1000;
const COLS = "id, user_id, name, phone, jid, text, send_at, status, sent_at, error, media_kind, media_name";

/** "com a foto" / "com o arquivo Proposta.pdf", para o resumo do "sim" e a Agenda. */
export function attachmentLabel(a: { kind?: string | null; name?: string | null } | null | undefined) {
  if (!a?.kind) return "";
  return a.kind === "image" ? "com a foto" : `com o arquivo ${a.name || "anexo"}`;
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
  attachment?: DirectAttachment | null;
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

  const att = opts.attachment;
  const row = await one<{ id: string }>(
    `INSERT INTO direct_messages (user_id, name, phone, text, send_at, media, media_kind, media_mimetype, media_name)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6, $7, $8, $9) RETURNING id`,
    [
      opts.user.id,
      opts.name?.trim().slice(0, 80) || null,
      phone,
      text,
      sendAt,
      att ? Buffer.from(att.base64, "base64") : null,
      att?.kind ?? null,
      att?.mimetype ?? null,
      att ? (att.fileName ?? null)?.slice(0, 120) ?? null : null,
    ],
  );
  const id = row!.id;
  const who = opts.name ? `${opts.name} (+${phone})` : `+${phone}`;
  const withFile = att ? { attachment: attachmentLabel({ kind: att.kind, name: att.fileName }) } : {};
  if (sendAt) {
    const boss = await getBoss();
    await boss.send(QUEUES.outbound, { type: "direct", directId: id }, { startAfter: sendAt, retryLimit: 2, retryDelay: 60, singletonKey: `direct:${id}` });
    return { ok: true, id, scheduled_for: formatLocal(sendAt, opts.timezone), to: who, message: text, ...withFile, tip: "Fica na Agenda do painel, onde dá para cancelar." };
  }
  const r = await sendDirect(id);
  return r.ok ? { ok: true, id, sent_to: who, message: text, ...withFile } : r;
}

/** Envia (na hora ou quando o agendamento vence). Agendada avisa quem pediu que saiu. */
export async function sendDirect(id: string, opts: { notify?: boolean } = {}) {
  const d = await one<DirectMessage & { media: Buffer | null; media_mimetype: string | null }>(
    "UPDATE direct_messages SET status = 'sending' WHERE id = $1 AND status = 'scheduled' RETURNING *",
    [id],
  );
  if (!d) return { ok: false, error: "Essa mensagem já foi enviada ou cancelada." };
  try {
    const exists = await findOnWhatsApp(phoneVariants(d.phone));
    if (exists === null) throw new Error(`O número +${d.phone} não tem WhatsApp.`);
    const channel = outboundChannel();
    const jid = exists ?? (await jidFor(d.phone, channel));
    if (d.media?.length) {
      // texto curto vai de legenda (uma mensagem só, como a pessoa mandaria); longo sai antes, em balão próprio
      const caption = d.text.length <= CAPTION_MAX ? d.text : undefined;
      if (!caption) await channel.sendText(jid, d.text);
      await channel.sendImage(jid, {
        kind: d.media_kind === "image" ? "image" : "document",
        base64: d.media.toString("base64"),
        mimetype: d.media_mimetype ?? "application/octet-stream",
        fileName: d.media_name ?? undefined,
        caption,
      });
    } else await channel.sendText(jid, d.text);
    // o arquivo só ficava aqui até sair
    await query("UPDATE direct_messages SET status = 'sent', sent_at = now(), jid = $2, error = NULL, media = NULL WHERE id = $1", [id, jid]);
    await logContactMessage(d.user_id, d.phone, d.name, "out", d.media_kind ? `${d.text}\n[${attachmentLabel({ kind: d.media_kind, name: d.media_name })}]` : d.text);
    if (opts.notify) await notifyUser(d.user_id, `Mandei para ${d.name ?? `+${d.phone}`} a mensagem que você agendou.`).catch(() => {});
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await query("UPDATE direct_messages SET status = 'failed', error = $2, media = NULL WHERE id = $1", [id, msg.slice(0, 300)]);
    if (opts.notify) await notifyUser(d.user_id, `Não consegui mandar a mensagem agendada para ${d.name ?? `+${d.phone}`}: ${msg}`).catch(() => {});
    return { ok: false, error: msg, no_whatsapp: /não tem WhatsApp/.test(msg) };
  }
}

export async function listDirect(userId: string) {
  return many<DirectMessage>(`SELECT ${COLS} FROM direct_messages WHERE user_id = $1 AND status = 'scheduled' ORDER BY send_at LIMIT 30`, [userId]);
}

export async function cancelDirect(userId: string, id: string) {
  const r = await one("UPDATE direct_messages SET status = 'cancelled', media = NULL WHERE id::text = $1 AND user_id = $2 AND status = 'scheduled' RETURNING id", [id, userId]);
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
  await logContactMessage(d.user_id, d.phone, d.name || msg.pushName || null, "in", String(body ?? ""));
  await notifyUser(d.user_id, `*${who}* respondeu:\n\n${String(body ?? "").slice(0, 2000)}`, undefined, { from: who });
  return true;
}

/** Resumo para a pessoa, usado no resultado das ferramentas. */
export function describeDirect(d: DirectMessage, tz: string) {
  return { id: d.id, to: d.name ? `${d.name} (+${d.phone})` : `+${d.phone}`, when: formatLocal(new Date(d.send_at), tz), text: d.text.slice(0, 200), ...(d.media_kind ? { attachment: attachmentLabel({ kind: d.media_kind, name: d.media_name }) } : {}) };
}

// ---------- Conversas com contatos (tela Recados) ----------

/** Quanto tempo a conversa com um contato fica guardada para a tela Recados (a limpeza de hora em hora apaga o resto). */
export const CONTACT_LOG_DAYS = 30;

/** Guarda uma mensagem da conversa da pessoa com um contato. Nunca derruba o envio. */
export async function logContactMessage(userId: string, phone: string, name: string | null | undefined, dir: "out" | "in", text: string) {
  const t = redactSecrets(text).trim().slice(0, 3000);
  if (!t) return;
  await query("INSERT INTO contact_messages (user_id, phone, name, dir, text) VALUES ($1, $2, $3, $4, $5)", [userId, phone, name?.trim().slice(0, 80) || null, dir, t]).catch(() => {});
}

type ContactLine = { from: "nos" | "eles"; text: string; at: string };

/**
 * Todo mundo com quem o assistente está conversando em nome da pessoa (fora os recados com estabelecimentos):
 * mensagens avulsas, contatos do Planejai, respostas e as agendadas que ainda vão sair. Uma conversa por número.
 */
export async function listContactChats(userId: string) {
  const [rows, scheduled] = await Promise.all([
    many<{ phone: string; name: string | null; dir: "out" | "in"; text: string; created_at: string }>(
      `SELECT phone, name, dir, text, created_at FROM contact_messages
        WHERE user_id = $1 AND created_at > now() - make_interval(days => $2) ORDER BY created_at LIMIT 1000`,
      [userId, CONTACT_LOG_DAYS],
    ),
    many<DirectMessage>("SELECT * FROM direct_messages WHERE user_id = $1 AND status = 'scheduled' ORDER BY send_at LIMIT 30", [userId]),
  ]);
  const chats = new Map<string, { phone: string; name: string | null; log: ContactLine[]; scheduled: { id: string; text: string; send_at: string }[]; updated_at: string }>();
  const chat = (phone: string, name: string | null, at: string) => {
    const c = chats.get(phone) ?? { phone, name: null, log: [], scheduled: [], updated_at: at };
    if (name) c.name = name;
    if (at > c.updated_at) c.updated_at = at;
    chats.set(phone, c);
    return c;
  };
  for (const r of rows) {
    const at = new Date(r.created_at).toISOString();
    chat(r.phone, r.name, at).log.push({ from: r.dir === "out" ? "nos" : "eles", text: r.text, at });
  }
  // a ordem da lista é pela última coisa que aconteceu (o pedido da agendada), nunca por um horário no futuro
  for (const d of scheduled) chat(d.phone, d.name, new Date((d as DirectMessage & { created_at: string }).created_at).toISOString()).scheduled.push({ id: d.id, text: d.text, send_at: new Date(d.send_at).toISOString() });
  if (!chats.size) return [];

  // nome: o da agenda de contatos da pessoa ou o cadastro de quem usa o Planejai, quando a mensagem não trouxe
  const phones = [...chats.keys()];
  const all = phones.flatMap((p) => phoneVariants(p));
  const [book, members] = await Promise.all([
    many<{ phone: string; name: string }>("SELECT phone, name FROM phonebook WHERE user_id = $1 AND phone = ANY($2)", [userId, all]),
    many<{ phone: string; name: string }>("SELECT phone, COALESCE(full_name, name) AS name FROM users WHERE phone = ANY($1) AND status = 'active'", [all]),
  ]);
  const find = (list: { phone: string; name: string }[], phone: string) => {
    const v = phoneVariants(phone);
    return list.find((x) => v.includes(x.phone));
  };
  return [...chats.values()]
    .map((c) => {
      const member = find(members, c.phone);
      const last = c.log.at(-1) ?? null;
      return {
        phone: c.phone,
        name: c.name || find(book, c.phone)?.name || member?.name || null,
        member: Boolean(member),
        // a última palavra foi deles: a pessoa ainda não respondeu pelo assistente
        waiting_you: last?.from === "eles",
        updated_at: c.updated_at,
        last: last ? { ...last, text: last.text.slice(0, 140) } : null,
        log: c.log.slice(-60),
        scheduled: c.scheduled,
      };
    })
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}
