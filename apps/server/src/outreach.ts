import { normalizePhone } from "./accounts.js";
import type { InboundMessage } from "./channels/types.js";
import { getChannel } from "./channels/index.js";
import { config } from "./config.js";
import { many, one, query } from "./db/pool.js";
import { isOwner, phoneVariants } from "./ingest.js";
import { reserveSlot } from "./shortmem.js";

/**
 * Proteção do número com quem não usa o Planejai (mensagem avulsa, recado, convite). O que mais derruba um
 * número no WhatsApp é gente que recebe sem esperar e bloqueia ou denuncia, então:
 * - SAIR: quem não é cliente responde SAIR e para de receber (tabela wa_optouts); VOLTAR libera de novo.
 * - Número novo (nunca recebeu nada nosso): os primeiros contatos saem espaçados no servidor todo, com folga
 *   aleatória, em vez de vários de uma vez. Convite já tem o próprio ritmo (INVITE_GAP_SECONDS).
 */
const OPT_OUT = /^(sair|parar|pare|stop|descadastrar|cancelar inscricao|nao quero (mais )?receber( mais)?( mensage(m|ns))?( daqui)?)$/;
const OPT_IN = /^(voltar|volta)$/;
export const OPT_OUT_HINT = "_Se não quiser receber mensagens daqui, responda SAIR._";
export const OPTED_OUT_ERROR = "Essa pessoa pediu para não receber mensagens do Planejai (respondeu SAIR). Não dá para mandar.";

/** folga aleatória somada ao NEW_CONTACT_GAP_SECONDS entre primeiros contatos */
const NEW_CONTACT_JITTER_MS = 20_000;
/** espera máxima na hora; mais que isso, a mensagem avulsa vai para a fila e o recado pede para tentar depois */
export const MAX_PACE_WAIT_MS = 45_000;

const plain = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[!.,;:~?*_"']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export async function isOptedOut(phone: string) {
  return Boolean(await one("SELECT 1 AS ok FROM wa_optouts WHERE phone = ANY($1)", [phoneVariants(normalizePhone(phone))]));
}

/** Nunca recebeu mensagem avulsa nem recado nosso? */
export async function isNewContact(phone: string) {
  const v = phoneVariants(normalizePhone(phone));
  const seen = await one(
    `SELECT 1 AS ok WHERE EXISTS (SELECT 1 FROM direct_messages WHERE phone = ANY($1) AND status = 'sent')
        OR EXISTS (SELECT 1 FROM errands WHERE phone = ANY($1))`,
    [v],
  );
  return !seen;
}

/** ms até a vez deste primeiro contato (0 = pode ir; sem Redis não espaça). */
export async function newContactWait(phone: string) {
  if (!config.NEW_CONTACT_GAP_SECONDS || !(await isNewContact(phone))) return 0;
  return (await reserveSlot("wa:new-contact", config.NEW_CONTACT_GAP_SECONDS * 1000 + Math.random() * NEW_CONTACT_JITTER_MS)) ?? 0;
}

/** SAIR / VOLTAR de quem não é cliente. true = tratado aqui (não segue para o assistente). */
export async function handleOptOut(msg: InboundMessage): Promise<boolean> {
  if (msg.kind !== "text" || !msg.phone || isOwner(msg.phone)) return false;
  const said = plain(msg.text);
  const out = OPT_OUT.test(said);
  if (!out && !OPT_IN.test(said)) return false;
  const variants = phoneVariants(msg.phone);
  if (await one("SELECT 1 AS ok FROM users WHERE phone = ANY($1) AND status = 'active'", [variants])) return false;
  const phone = normalizePhone(msg.phone);
  const channel = getChannel(msg.channel);
  if (!out) {
    const r = await query("DELETE FROM wa_optouts WHERE phone = ANY($1)", [variants]);
    if (!r.rowCount) return false;
    await channel.sendText(msg.remoteJid, "Pronto, liberado de novo. 🙂").catch(() => {});
    return true;
  }
  await query("INSERT INTO wa_optouts (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING", [phone]);
  // o que estava para sair para esse número não sai mais; quem mandou fica sabendo
  const senders = await many<{ user_id: string; name: string | null }>(
    `WITH d AS (
       UPDATE direct_messages SET status = 'cancelled', media = NULL WHERE phone = ANY($1) AND status = 'scheduled' RETURNING user_id, name
     ), e AS (
       UPDATE errands SET status = 'cancelled', updated_at = now() WHERE phone = ANY($1) AND status IN ('waiting', 'asking') RETURNING user_id, place AS name
     ), recent AS (
       SELECT user_id, name FROM direct_messages WHERE phone = ANY($1) AND status = 'sent' AND sent_at > now() - interval '72 hours'
     )
     SELECT DISTINCT ON (user_id) user_id, name FROM (SELECT * FROM d UNION ALL SELECT * FROM e UNION ALL SELECT * FROM recent) x`,
    [variants],
  );
  await channel.sendText(msg.remoteJid, "Pronto, você não vai mais receber mensagens por aqui. Se mudar de ideia, é só mandar VOLTAR.").catch(() => {});
  const { notifyUser } = await import("./social.js");
  for (const s of senders) {
    await notifyUser(s.user_id, `${s.name ?? `+${phone}`} pediu para não receber mais mensagens pelo Planejai (respondeu SAIR). Não mando mais nada para esse número.`).catch(() => {});
  }
  return true;
}
