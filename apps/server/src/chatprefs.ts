import { normalizePhone } from "./accounts.js";
import { many, one, query } from "./db/pool.js";
import { phoneVariants } from "./ingest.js";

/**
 * Jeito de cada conversa da tela Recados (por número, de cada pessoa): apelido, cor, tom do assistente,
 * assinatura, anotação, fixar e arquivar. E o acompanhamento: se a resposta daquele número volta para a pessoa.
 * - follow 'auto': como sempre foi (resposta volta até 72h depois da última mensagem avulsa; recado até vencer).
 * - follow 'on': volta sem prazo, até ela parar. 'off': não volta mais (mandar algo de novo volta para 'auto').
 * - Excluir acompanhamento: para, cancela o que estava agendado ou aberto e apaga a conversa da tela.
 */

export const CHAT_COLORS = ["violeta", "azul", "verde", "ambar", "rosa", "cinza"] as const;
export const CHAT_TONES: Record<string, string> = {
  formal: "formal e educado (senhor/senhora, sem gíria)",
  descontraido: "descontraído e próximo, como amigo",
  curto: "curto e direto, sem rodeio",
};
export type Follow = "auto" | "on" | "off";

export interface ChatPrefs {
  phone: string;
  nickname: string | null;
  color: string | null;
  tone: string | null;
  signature: string | null;
  note: string | null;
  pinned: boolean;
  archived: boolean;
  follow: Follow;
  removed_at: string | null;
}

const COLS = "phone, nickname, color, tone, signature, note, pinned, archived, follow, removed_at";

export async function getPrefs(userId: string, phone: string): Promise<ChatPrefs | undefined> {
  return one<ChatPrefs>(`SELECT ${COLS} FROM chat_prefs WHERE user_id = $1 AND phone = ANY($2) ORDER BY updated_at DESC LIMIT 1`, [userId, phoneVariants(normalizePhone(phone))]);
}

/** Preferências de vários números de uma vez, pela chave que a tela usa (aceita o número com ou sem o 9). */
export async function prefsFor(userId: string, phones: string[]): Promise<Record<string, ChatPrefs>> {
  if (!phones.length) return {};
  const rows = await many<ChatPrefs>(`SELECT ${COLS} FROM chat_prefs WHERE user_id = $1 AND phone = ANY($2)`, [userId, phones.flatMap((p) => phoneVariants(p))]);
  const out: Record<string, ChatPrefs> = {};
  for (const p of new Set(phones)) {
    const v = phoneVariants(p);
    const hit = rows.find((r) => v.includes(r.phone));
    if (hit) out[p] = hit;
  }
  return out;
}

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) || null : null);

export type PrefsPatch = Partial<Pick<ChatPrefs, "nickname" | "color" | "tone" | "signature" | "note" | "pinned" | "archived" | "follow">>;

/** Grava só o que veio; campo de texto vazio volta ao padrão. Parar de acompanhar também cancela o recado aberto. */
export async function savePrefs(userId: string, rawPhone: string, patch: PrefsPatch) {
  const phone = normalizePhone(rawPhone);
  if (phone.length < 10 || phone.length > 13) return { ok: false as const, error: "Número inválido" };
  const cur = (await getPrefs(userId, phone)) ?? null;
  const next = {
    nickname: "nickname" in patch ? clean(patch.nickname, 40) : (cur?.nickname ?? null),
    color: "color" in patch ? (CHAT_COLORS as readonly string[]).includes(String(patch.color)) ? String(patch.color) : null : (cur?.color ?? null),
    tone: "tone" in patch ? (String(patch.tone) in CHAT_TONES ? String(patch.tone) : null) : (cur?.tone ?? null),
    signature: "signature" in patch ? clean(patch.signature, 60) : (cur?.signature ?? null),
    note: "note" in patch ? clean(patch.note, 240) : (cur?.note ?? null),
    pinned: "pinned" in patch ? Boolean(patch.pinned) : (cur?.pinned ?? false),
    archived: "archived" in patch ? Boolean(patch.archived) : (cur?.archived ?? false),
    follow: "follow" in patch && ["auto", "on", "off"].includes(String(patch.follow)) ? (patch.follow as Follow) : (cur?.follow ?? "auto"),
  };
  const key = cur?.phone ?? phone;
  await query(
    `INSERT INTO chat_prefs (user_id, phone, nickname, color, tone, signature, note, pinned, archived, follow)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (user_id, phone) DO UPDATE SET nickname = $3, color = $4, tone = $5, signature = $6, note = $7, pinned = $8, archived = $9, follow = $10, updated_at = now()`,
    [userId, key, next.nickname, next.color, next.tone, next.signature, next.note, next.pinned, next.archived, next.follow],
  );
  if (next.follow === "off" && cur?.follow !== "off") await cancelOpenErrands(userId, key);
  // Sem prazo: o recado aberto deixa de vencer (um ano de folga), em vez de parar de acompanhar nos 7 dias
  if (next.follow === "on" && cur?.follow !== "on")
    await query("UPDATE errands SET expires_at = now() + interval '365 days' WHERE user_id = $1 AND phone = ANY($2) AND status IN ('waiting', 'asking')", [userId, phoneVariants(key)]);
  return { ok: true as const, prefs: await getPrefs(userId, key) };
}

async function cancelOpenErrands(userId: string, phone: string) {
  const { cancelErrand } = await import("./errands.js");
  const open = await many<{ id: string }>("SELECT id FROM errands WHERE user_id = $1 AND phone = ANY($2) AND status IN ('waiting', 'asking')", [userId, phoneVariants(phone)]);
  for (const e of open) await cancelErrand(e.id, userId);
  return open.length;
}

/**
 * Excluir acompanhamento: nada mais volta desse número, o que estava agendado ou aberto é cancelado (nada é
 * enviado a eles) e a conversa some da tela. O apelido e o jeito ficam guardados para a próxima vez.
 */
export async function removeChat(userId: string, rawPhone: string) {
  const phone = normalizePhone(rawPhone);
  const v = phoneVariants(phone);
  const cur = await getPrefs(userId, phone);
  const key = cur?.phone ?? phone;
  const cancelled = await cancelOpenErrands(userId, key);
  const scheduled = await many("UPDATE direct_messages SET status = 'cancelled', media = NULL WHERE user_id = $1 AND phone = ANY($2) AND status = 'scheduled' RETURNING id", [userId, v]);
  await query("UPDATE direct_messages SET hidden = true WHERE user_id = $1 AND phone = ANY($2) AND status IN ('sent', 'failed')", [userId, v]);
  await query("DELETE FROM contact_messages WHERE user_id = $1 AND phone = ANY($2)", [userId, v]);
  await query("UPDATE errands SET hidden = true WHERE user_id = $1 AND phone = ANY($2)", [userId, v]);
  await query(
    `INSERT INTO chat_prefs (user_id, phone, follow, removed_at) VALUES ($1, $2, 'off', now())
     ON CONFLICT (user_id, phone) DO UPDATE SET follow = 'off', pinned = false, archived = false, removed_at = now(), updated_at = now()`,
    [userId, key],
  );
  return { ok: true, cancelled_errands: cancelled, cancelled_scheduled: scheduled.length };
}

/** A pessoa voltou a mandar algo para esse número: o "parou de acompanhar" deixa de valer. */
export async function resumeFollow(userId: string, phone: string) {
  await query("UPDATE chat_prefs SET follow = 'auto', updated_at = now() WHERE user_id = $1 AND phone = ANY($2) AND follow = 'off'", [userId, phoneVariants(normalizePhone(phone))]).catch(() => {});
}

/** Quem acompanha esse número sem prazo (a mais recente, se houver mais de uma pessoa). */
export async function followerOf(phone: string) {
  return one<ChatPrefs & { user_id: string }>(`SELECT user_id, ${COLS} FROM chat_prefs WHERE phone = ANY($1) AND follow = 'on' ORDER BY updated_at DESC LIMIT 1`, [phoneVariants(normalizePhone(phone))]);
}

/** Assinatura combinada no fim da mensagem, se ainda não estiver lá. */
export function withSignature(text: string, signature: string | null | undefined) {
  const s = signature?.trim();
  if (!s || text.trimEnd().endsWith(s)) return text;
  return `${text.trimEnd()}\n\n${s}`;
}

/** Uma linha para o agente escrever do jeito combinado com esse número (vazio se não tem nada combinado). */
export function styleHint(p: Pick<ChatPrefs, "tone" | "note" | "nickname"> | null | undefined) {
  if (!p) return "";
  const parts = [p.tone && CHAT_TONES[p.tone] ? `tom ${CHAT_TONES[p.tone]}` : "", p.note ? `anotação da pessoa: ${p.note}` : ""].filter(Boolean);
  return parts.join("; ");
}
