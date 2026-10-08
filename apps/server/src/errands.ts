import { normalizePhone } from "./accounts.js";
import { humanize } from "./agent/humanize.js";
import { redactSecrets } from "./agent/guard.js";
import type { InboundMessage } from "./channels/types.js";
import { many, one, query } from "./db/pool.js";
import { isOwner, phoneVariants } from "./ingest.js";
import { QUEUES, getBoss } from "./queue/boss.js";
import { createReminder } from "./reminders.js";
import { markSeen } from "./shortmem.js";
import { jidFor, notifyUser, outboundChannel } from "./social.js";
import { formatLocal } from "./time.js";
import { whatsapp } from "./whatsapp/session.js";

/**
 * Recados: o assistente fala com um estabelecimento (petshop, salão, clínica) pelo WhatsApp em nome da pessoa.
 * "Acha o petshop mais perto, pergunta os horários e, se tiver 18h, agenda pra mim."
 *
 * - Começa só depois do "sim" da pessoa (errand_start usa requireConfirmation): o resumo diz para quem vai, o texto
 *   e o que já fica liberado para fechar sem perguntar de novo (ex.: "se tiver 18h hoje, confirmar").
 * - A resposta do estabelecimento não vira cliente nem conversa com o CTO: o ingest entrega aqui (handleErrandInbound)
 *   e um agente pequeno, com só três ferramentas, decide: responder a eles, fechar ou perguntar à pessoa.
 * - Travas no servidor: só fala com aquele número, no máximo MAX_ERRAND_MESSAGES mensagens, vence em `hours`,
 *   e dinheiro ou dado pessoal sempre volta para a pessoa.
 */

export const MAX_ERRAND_MESSAGES = 6;
export const MAX_OPEN_ERRANDS = 3;
export const MAX_ERRANDS_PER_DAY = 10;
const OPEN = ["waiting", "asking"];

export interface ErrandLogEntry {
  /** nos = o assistente para eles; eles = o estabelecimento; pessoa = o que a pessoa decidiu no meio */
  from: "nos" | "eles" | "pessoa";
  text: string;
  at: string;
  kind?: string;
  media?: unknown;
  external_id?: string;
}

export interface Errand {
  id: string;
  user_id: string;
  conversation_id: string;
  place: string;
  phone: string;
  jid: string;
  goal: string;
  allowed: string | null;
  status: string;
  log: ErrandLogEntry[];
  sent: number;
  question: string | null;
  outcome: string | null;
  appointment_at: string | null;
  expires_at: string;
}

const firstName = (u: { full_name?: string | null; name?: string | null }) => (u.full_name || u.name || "").split(" ")[0] || null;

/** O estabelecimento precisa saber que fala com um assistente: se a primeira mensagem não diz, o servidor diz. */
export function introduce(text: string, personName: string | null) {
  const t = text.trim();
  if (/assistente/i.test(t)) return t;
  const who = personName ? `assistente virtual de ${personName}` : "um assistente virtual";
  const rest = t.replace(/^(oi|olá|ola|bom dia|boa tarde|boa noite)[!,.]?\s*/i, "");
  return `Oi! Aqui é ${who}. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}

export async function openErrands(userId: string): Promise<Errand[]> {
  return many<Errand>(`SELECT * FROM errands WHERE user_id = $1 AND status = ANY($2) AND expires_at > now() ORDER BY created_at`, [userId, OPEN]);
}

/** Este número do WhatsApp existe? (só dá para saber com o Baileys conectado; senão confia) */
async function onWhatsApp(phone: string): Promise<string | null | undefined> {
  const sock = whatsapp.connected ? whatsapp.sock : null;
  if (!sock) return undefined;
  for (const v of phoneVariants(phone)) {
    try {
      const [r] = (await sock.onWhatsApp(`${v}@s.whatsapp.net`)) ?? [];
      if (r?.exists) return r.jid;
    } catch {
      /* tenta a próxima */
    }
  }
  return null;
}

export async function startErrand(opts: {
  user: { id: string; phone: string; name?: string | null; full_name?: string | null };
  conversationId: string;
  place: string;
  phone: string;
  message: string;
  goal: string;
  allowed?: string | null;
  hours?: number;
}) {
  const phone = normalizePhone(opts.phone);
  if (phone.length < 12 || phone.length > 13) return { ok: false, error: `Telefone inválido: ${opts.phone}. Precisa do DDD.` };
  const variants = phoneVariants(phone);
  if (variants.some((v) => phoneVariants(opts.user.phone).includes(v)) || isOwner(phone)) return { ok: false, error: "Esse número é da própria pessoa." };
  const member = await one("SELECT id FROM users WHERE phone = ANY($1) AND status = 'active'", [variants]);
  if (member) return { ok: false, error: "Esse número é de alguém que usa o Planejai: use send_to_contact ou invite_person." };
  const busy = await one(`SELECT user_id FROM errands WHERE phone = ANY($1) AND status = ANY($2) AND expires_at > now()`, [variants, OPEN]);
  if (busy && busy.user_id !== opts.user.id) return { ok: false, error: "Já tem outro recado em andamento com esse número. Tente de novo mais tarde." };
  if (busy) await query(`UPDATE errands SET status = 'cancelled', updated_at = now() WHERE user_id = $1 AND phone = ANY($2) AND status = ANY($3)`, [opts.user.id, variants, OPEN]);
  if ((await openErrands(opts.user.id)).length >= MAX_OPEN_ERRANDS) return { ok: false, error: `Já tem ${MAX_OPEN_ERRANDS} recados em andamento. Espere um terminar ou cancele um (errand_cancel).` };
  const today = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM errands WHERE user_id = $1 AND created_at > now() - interval '24 hours'", [opts.user.id]);
  if ((today?.n ?? 0) >= MAX_ERRANDS_PER_DAY) return { ok: false, error: "Limite de recados por dia atingido. Amanhã dá de novo." };

  const exists = await onWhatsApp(phone);
  if (exists === null) return { ok: false, error: `O número ${phone} não tem WhatsApp. Sugira à pessoa ligar: +${phone}.`, no_whatsapp: true };
  const channel = outboundChannel();
  const jid = exists ?? (await jidFor(phone, channel));
  const text = redactSecrets(humanize(introduce(opts.message, firstName(opts.user))));
  await channel.sendText(jid, text);
  const hours = Math.min(Math.max(opts.hours ?? 24, 1), 72);
  const log: ErrandLogEntry[] = [{ from: "nos", text, at: new Date().toISOString() }];
  const row = await one<{ id: string }>(
    `INSERT INTO errands (user_id, conversation_id, place, phone, jid, goal, allowed, log, sent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, now() + make_interval(hours => $9)) RETURNING id`,
    [opts.user.id, opts.conversationId, opts.place.slice(0, 120), phone, jid, opts.goal.slice(0, 1000), opts.allowed?.slice(0, 500) || null, JSON.stringify(log), hours],
  );
  return { ok: true, errand_id: row!.id, sent_to: `${opts.place} (+${phone})`, message: text, waiting_hours: hours };
}

/** Mensagem nossa para o estabelecimento, dentro das travas. */
export async function sendToErrand(errandId: string, text: string) {
  const e = await one<Errand>("SELECT * FROM errands WHERE id = $1", [errandId]);
  if (!e || !OPEN.includes(e.status)) return { ok: false, error: "Esse recado já terminou." };
  if (e.sent >= MAX_ERRAND_MESSAGES) return { ok: false, error: `Já foram ${MAX_ERRAND_MESSAGES} mensagens para eles. Feche com errand_done ou pergunte à pessoa.` };
  const clean = redactSecrets(humanize(text.trim())).slice(0, 1000);
  if (!clean) return { ok: false, error: "Mensagem vazia" };
  await outboundChannel().sendText(e.jid, clean);
  await query(
    // fechar e responder podem vir juntos (em paralelo): mandar não reabre um recado que acabou de fechar
    `UPDATE errands SET sent = sent + 1, log = log || $2::jsonb, updated_at = now(),
       status = CASE WHEN status IN ('waiting', 'asking') THEN 'waiting' ELSE status END,
       question = CASE WHEN status IN ('waiting', 'asking') THEN NULL ELSE question END
     WHERE id = $1`,
    [errandId, JSON.stringify([{ from: "nos", text: clean, at: new Date().toISOString() }])],
  );
  return { ok: true, sent: clean, messages_left: MAX_ERRAND_MESSAGES - e.sent - 1 };
}

/**
 * Chegou mensagem de um número com recado aberto: guarda no recado e agenda a vez do agente (com uma folga,
 * porque estabelecimento costuma mandar várias mensagens seguidas). Devolve true quando era resposta de recado.
 */
export async function handleErrandInbound(msg: InboundMessage): Promise<boolean> {
  if (!msg.phone || msg.kind === "reaction") return false;
  const e = await one<Errand>(`SELECT * FROM errands WHERE phone = ANY($1) AND status = ANY($2) AND expires_at > now() ORDER BY updated_at DESC LIMIT 1`, [
    phoneVariants(msg.phone),
    OPEN,
  ]);
  if (!e) return false;
  if (msg.externalId && (await markSeen(`errand:${msg.channel}:${msg.externalId}`, 48 * 3600)) === false) return true;
  const entry: ErrandLogEntry = { from: "eles", text: msg.text ?? "", at: new Date().toISOString(), kind: msg.kind, external_id: msg.externalId };
  if (msg.media && msg.kind !== "text") entry.media = msg.media;
  await query("UPDATE errands SET log = log || $2::jsonb, updated_at = now() WHERE id = $1", [e.id, JSON.stringify([entry])]);
  const boss = await getBoss();
  await boss.send(QUEUES.errand, { errandId: e.id }, { singletonKey: e.id, startAfter: 15, retryLimit: 1, retryDelay: 30, expireInSeconds: 600 });
  return true;
}

/** Fecha o recado; se marcou horário, cria o lembrete da pessoa sem IA. */
export async function finishErrand(errandId: string, opts: { status: "done" | "failed" | "cancelled"; outcome: string; appointmentAt?: Date | null; timezone: string }) {
  const e = await one<Errand>("UPDATE errands SET status = $2, outcome = $3, appointment_at = $4, updated_at = now() WHERE id = $1 AND status = ANY($5) RETURNING *", [
    errandId,
    opts.status,
    opts.outcome.slice(0, 1000),
    opts.appointmentAt ?? null,
    OPEN,
  ]);
  if (!e) return { ok: false, error: "Esse recado já tinha terminado." };
  let reminder: string | null = null;
  if (opts.appointmentAt && opts.appointmentAt.getTime() > Date.now()) {
    // 1h antes; se faltar menos que isso, 15 min antes; se nem isso, na hora
    const ahead = opts.appointmentAt.getTime() - Date.now();
    const lead = ahead > 2 * 3600_000 ? 3600_000 : ahead > 30 * 60_000 ? 15 * 60_000 : 0;
    const due = new Date(opts.appointmentAt.getTime() - lead);
    const r = await createReminder({
      userId: e.user_id,
      conversationId: e.conversation_id,
      intent: `Compromisso marcado pelo assistente com ${e.place} às ${formatLocal(opts.appointmentAt, opts.timezone)}: ${opts.outcome}`,
      dueAt: due,
      timezone: opts.timezone,
    }).catch(() => null);
    if (r) reminder = formatLocal(due, opts.timezone);
  }
  return { ok: true, place: e.place, reminder };
}

/** Recados sem resposta no prazo: avisa a pessoa uma vez, sem IA. */
export async function expireErrands() {
  const rows = await many<Errand>(
    `UPDATE errands SET status = 'expired', updated_at = now() WHERE status = ANY($1) AND expires_at < now() RETURNING *`,
    [OPEN],
  );
  for (const e of rows) {
    const answered = e.log.some((l) => l.from === "eles");
    await notifyUser(
      e.user_id,
      answered
        ? `A conversa com ${e.place} parou no meio e eu deixei de acompanhar. Se quiser, te passo o número para você falar direto: +${e.phone}`
        : `${e.place} não respondeu minha mensagem, então parei de esperar. Se quiser, dá para ligar: +${e.phone}`,
    ).catch(() => {});
  }
  return rows.length;
}

/** Uma linha por recado aberto, para o CTO saber do que a pessoa está falando. */
export function errandsContext(list: Errand[]) {
  return list
    .map(
      (e) =>
        `${e.place} (id ${e.id}): ${e.goal}` +
        (e.status === "asking" && e.question ? ` · ESPERANDO A PESSOA DECIDIR: ${e.question}` : " · esperando resposta deles") +
        (e.allowed ? ` · já liberado: ${e.allowed}` : ""),
    )
    .join("\n");
}
