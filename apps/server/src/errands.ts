import { normalizePhone } from "./accounts.js";
import { humanize } from "./agent/humanize.js";
import { redactSecrets } from "./agent/guard.js";
import type { InboundMessage } from "./channels/types.js";
import { many, one, query } from "./db/pool.js";
import { isOwner, phoneVariants } from "./ingest.js";
import { QUEUES, getBoss } from "./queue/boss.js";
import { resolveTag } from "./agenda-tags.js";
import { createReminder } from "./reminders.js";
import { markSeen } from "./shortmem.js";
import { jidFor, notifyUser, outboundChannel } from "./social.js";
import { config } from "./config.js";
import { formatLocal, isoLocal } from "./time.js";
import { findOnWhatsApp } from "./whatsapp/rpc.js";
import { MAX_ERRAND_TEXT } from "./agent/errand-check.js";

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

/** "bom dia", "boa tarde" ou "boa noite" no fuso da pessoa. */
export function greetingFor(date: Date, timezone: string) {
  const h = Number(isoLocal(date, timezone).slice(11, 13));
  return h >= 5 && h < 12 ? "bom dia" : h >= 12 && h < 18 ? "boa tarde" : "boa noite";
}

const END = "(?=[\\s!,.?]|$)";
const GREETING = new RegExp(`^\\s*((oi|olá|ola|e aí|e ai)${END})?[!,.]*\\s*((bom dia|boa tarde|boa noite)${END})?[!,.]*\\s*((tudo bem|tudo bom|como vai)${END})?[!,.?]*\\s*`, "i");

/**
 * Primeira mensagem para o estabelecimento: cumprimento certo para a hora local e a apresentação honesta
 * (assistente virtual de quem). Se o texto já se apresenta, só acerta o "bom dia/boa tarde/boa noite".
 * Sem fuso (mensagem direta, que pode ser agendada para outra hora) fica a apresentação curta, sem período do dia.
 */
export function introduce(text: string, personName: string | null, timezone?: string, now = new Date()) {
  const t = text.trim();
  if (!timezone) {
    if (/assistente/i.test(t)) return t;
    const rest = t.replace(/^(oi|olá|ola|bom dia|boa tarde|boa noite)[!,.]?\s*/i, "");
    return `Oi! Aqui é ${personName ? `assistente virtual de ${personName}` : "um assistente virtual"}. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
  }
  const hello = greetingFor(now, timezone);
  if (/assistente/i.test(t)) return t.replace(/\b(bom dia|boa tarde|boa noite)\b/i, (m) => (m[0] === "B" ? hello.charAt(0).toUpperCase() + hello.slice(1) : hello));
  const who = personName ? `o assistente virtual de ${personName}` : "um assistente virtual";
  const rest = t.replace(GREETING, "");
  return `Oi, ${hello}! Tudo bem? Aqui é ${who}. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`.trim();
}

export async function openErrands(userId: string): Promise<Errand[]> {
  return many<Errand>(`SELECT * FROM errands WHERE user_id = $1 AND status = ANY($2) AND expires_at > now() ORDER BY created_at`, [userId, OPEN]);
}

/** Este número do WhatsApp existe? (só dá para saber com o Baileys conectado; senão confia) */
const onWhatsApp = (phone: string) => findOnWhatsApp(phoneVariants(phone));

export async function startErrand(opts: {
  user: { id: string; phone: string; name?: string | null; full_name?: string | null };
  conversationId: string;
  place: string;
  phone: string;
  message: string;
  goal: string;
  allowed?: string | null;
  hours?: number;
  timezone?: string;
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
  const text = redactSecrets(humanize(introduce(opts.message, firstName(opts.user), opts.timezone ?? config.DEFAULT_TIMEZONE)));
  await channel.sendText(jid, text);
  const hours = Math.min(Math.max(opts.hours ?? 24, 1), 72);
  const log: ErrandLogEntry[] = [{ from: "nos", text, at: new Date().toISOString() }];
  const row = await one<{ id: string }>(
    `INSERT INTO errands (user_id, conversation_id, place, phone, jid, goal, allowed, log, sent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, now() + make_interval(hours => $9)) RETURNING id`,
    [opts.user.id, opts.conversationId, opts.place.slice(0, 120), phone, jid, opts.goal.slice(0, 1000), opts.allowed?.slice(0, 500) || null, JSON.stringify(log), hours],
  );
  return {
    ok: true,
    errand_id: row!.id,
    sent_to: `${opts.place} (+${phone})`,
    message: text,
    waiting_hours: hours,
    tip: `Conte em uma linha que dá para acompanhar a conversa em ${followUrl()}`,
  };
}

/** Mensagem nossa para o estabelecimento, dentro das travas. */
export async function sendToErrand(errandId: string, text: string, opts: { sameTurn?: boolean } = {}) {
  const e = await one<Errand>("SELECT * FROM errands WHERE id = $1", [errandId]);
  // sameTurn: o agente fechou (ou levou à pessoa) nesta mesma vez e a despedida ainda está saindo
  const live = e && (OPEN.includes(e.status) || (opts.sameTurn && ["done", "failed"].includes(e.status)));
  if (!e || !live) return { ok: false, error: "Esse recado já terminou." };
  if (e.sent >= MAX_ERRAND_MESSAGES) return { ok: false, error: `Já foram ${MAX_ERRAND_MESSAGES} mensagens para eles. Feche com errand_done ou pergunte à pessoa.` };
  const clean = redactSecrets(humanize(text.trim())).slice(0, MAX_ERRAND_TEXT);
  if (!clean) return { ok: false, error: "Mensagem vazia" };
  await outboundChannel().sendText(e.jid, clean);
  await query(
    // fechar e responder podem vir juntos (em paralelo): mandar não reabre um recado que acabou de fechar
    `UPDATE errands SET sent = sent + 1, log = log || $2::jsonb, updated_at = now(),
       status = CASE WHEN status IN ('waiting', 'asking') AND NOT $3 THEN 'waiting' ELSE status END,
       question = CASE WHEN status IN ('waiting', 'asking') AND NOT $3 THEN NULL ELSE question END
     WHERE id = $1`,
    [errandId, JSON.stringify([{ from: "nos", text: clean, at: new Date().toISOString() }]), Boolean(opts.sameTurn)],
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
    // na agenda: bloco no horário do compromisso, com o nome do lugar e a tag do assunto
    const tag = await resolveTag(e.user_id, null, `${e.place} ${e.goal}`).catch(() => null);
    const r = await createReminder({
      userId: e.user_id,
      conversationId: e.conversation_id,
      intent: `Compromisso marcado pelo assistente com ${e.place} às ${formatLocal(opts.appointmentAt, opts.timezone)}: ${opts.outcome}`,
      dueAt: due,
      timezone: opts.timezone,
      title: e.place,
      eventAt: opts.appointmentAt,
      tag: tag?.name,
      color: tag?.color,
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

/** Onde a pessoa acompanha a conversa no painel. */
export const followUrl = () => `${config.PUBLIC_URL.replace(/\/+$/, "")}/recados`;

/** Situação para a tela: esperando eles, esperando você (decisão ou o "sim"), concluído, cancelado, vencido. */
function stateOf(e: Pick<Errand, "status" | "expires_at">, pending: boolean) {
  if (OPEN.includes(e.status) && new Date(e.expires_at).getTime() < Date.now()) return "expired";
  if (pending || e.status === "asking") return "you";
  if (e.status === "waiting") return "them";
  return e.status; // done, failed, cancelled, expired
}

interface PendingErrand {
  id: string;
  tool: "errand_start" | "errand_continue";
  args: { place?: string; phone?: string; message?: string; goal?: string; allowed?: string; errand_id?: string };
  created_at: string;
}

/** Pedidos de recado esperando o "sim" da pessoa no WhatsApp (o mesmo prazo do confirm.ts). */
async function pendingErrands(userId: string) {
  return many<PendingErrand>(
    `SELECT id::text, tool, args, created_at FROM pending_actions
      WHERE user_id = $1 AND tool IN ('errand_start', 'errand_continue') AND status = 'pending' AND created_at > now() - interval '30 minutes'
      ORDER BY id DESC`,
    [userId],
  );
}

/** O texto exato que sai quando a pessoa disser "sim" (mesmo caminho do startErrand/sendToErrand). */
function previewOf(p: PendingErrand, user: { name?: string | null; full_name?: string | null; timezone?: string | null }) {
  const raw = String(p.args.message ?? "");
  const text = p.tool === "errand_start" ? introduce(raw, firstName(user), user.timezone ?? config.DEFAULT_TIMEZONE) : raw.trim();
  return redactSecrets(humanize(text)).slice(0, MAX_ERRAND_TEXT);
}

/** Lista da tela Recados: só os da própria pessoa, com os pedidos que ainda esperam o "sim". */
export async function listErrands(userId: string) {
  const user = await one("SELECT name, full_name, timezone FROM users WHERE id = $1", [userId]);
  if (!user) return { errands: [], drafts: [], follow: followUrl() };
  const pending = await pendingErrands(userId);
  const rows = await many<Errand & { created_at: string; updated_at: string }>(
    `SELECT * FROM errands WHERE user_id = $1 ORDER BY (status IN ('waiting', 'asking') AND expires_at > now()) DESC, updated_at DESC LIMIT 50`,
    [userId],
  );
  const waitingYes = new Map(pending.filter((p) => p.tool === "errand_continue").map((p) => [String(p.args.errand_id), p]));
  return {
    // recado novo ainda não enviado: a pessoa vê exatamente o que vai sair antes de dizer "sim"
    drafts: pending
      .filter((p) => p.tool === "errand_start")
      .slice(0, 1)
      .map((p) => ({ id: p.id, place: p.args.place ?? "", phone: p.args.phone ?? "", goal: p.args.goal ?? "", allowed: p.args.allowed ?? null, preview: previewOf(p, user), created_at: p.created_at })),
    errands: rows.map((e) => {
      const p = waitingYes.get(e.id);
      const last = e.log.at(-1);
      return {
        id: e.id,
        place: e.place,
        phone: e.phone,
        goal: e.goal,
        allowed: e.allowed,
        state: stateOf(e, Boolean(p)),
        question: OPEN.includes(e.status) ? e.question : null,
        outcome: e.outcome,
        appointment_at: e.appointment_at,
        messages_left: Math.max(0, MAX_ERRAND_MESSAGES - e.sent),
        expires_at: e.expires_at,
        created_at: e.created_at,
        updated_at: e.updated_at,
        last: last ? { from: last.from, text: last.text.slice(0, 140), at: last.at } : null,
        log: e.log.map((l) => ({ from: l.from, text: l.text || (l.kind ? `(${l.kind})` : ""), at: l.at })),
        next: p ? { preview: previewOf(p, user), allowed: p.args.allowed ?? null, created_at: p.created_at } : null,
      };
    }),
    follow: followUrl(),
  };
}

/** Cancelar pela tela: não manda nada para o estabelecimento, só para de acompanhar. */
export async function cancelErrand(id: string, userId: string) {
  const e = await one<Errand>("SELECT * FROM errands WHERE id::text = $1 AND user_id = $2", [id, userId]);
  if (!e) return null;
  await query("UPDATE pending_actions SET status = 'cancelled', resolved_at = now() WHERE user_id = $1 AND tool = 'errand_continue' AND status = 'pending' AND args->>'errand_id' = $2", [userId, e.id]);
  return finishErrand(e.id, { status: "cancelled", outcome: "cancelado pela pessoa no painel", timezone: config.DEFAULT_TIMEZONE });
}

/** Descartar um recado que ainda esperava o "sim" (nada tinha saído). */
export async function discardErrandDraft(id: string, userId: string) {
  const r = await one("UPDATE pending_actions SET status = 'cancelled', resolved_at = now() WHERE id::text = $1 AND user_id = $2 AND tool = 'errand_start' AND status = 'pending' RETURNING id", [id, userId]);
  return Boolean(r);
}
