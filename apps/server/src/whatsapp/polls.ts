import { createHash, randomBytes } from "node:crypto";
import { decryptPollVote, jidNormalizedUser, normalizeMessageContent, type WAMessage, type WASocket } from "baileys";
import type { Channel } from "../channels/types.js";
import { one, query } from "../db/pool.js";
import type { Log } from "./types.js";

/**
 * "Sim" de ação sensível por enquete do WhatsApp (Baileys manda enquete de forma nativa; botões não).
 * O voto chega criptografado com a chave que guardamos em wa_polls e vira o texto "sim" ou "não" da própria
 * pessoa, que segue o caminho normal da confirmação (agent/confirm.ts). Só a enquete mais nova da conversa
 * vale, uma vez só e por 30 min; voto em enquete velha não libera nada.
 */
export const POLL_YES = "Sim";
export const POLL_NO = "Não";
const POLL_MINUTES = 30;
/** limite do WhatsApp para o título da enquete */
const NAME_MAX = 255;

export const pollQuestion = (what: string) => {
  const q = `Posso ${what.replace(/[.!?\s]+$/, "")}?`;
  return q.length <= NAME_MAX ? q : `${q.slice(0, NAME_MAX - 2).trimEnd()}…?`;
};

/** Manda a enquete Sim/Não e guarda a chave. Erro sobe para quem chamou cair no texto. */
export async function sendConfirmPoll(channel: Channel, jid: string, what: string) {
  if (!channel.sendPoll) throw new Error("canal sem enquete");
  const secret = randomBytes(32).toString("base64");
  const name = pollQuestion(what);
  const r = await channel.sendPoll(jid, { name, values: [POLL_YES, POLL_NO], secret });
  if (!r.id) throw new Error("enquete sem id");
  await query("INSERT INTO wa_polls (message_id, remote_jid, secret, options) VALUES ($1, $2, $3, $4) ON CONFLICT (message_id) DO NOTHING", [
    r.id,
    jid,
    secret,
    JSON.stringify([POLL_YES, POLL_NO]),
  ]);
  return { id: r.id, name };
}

const sha = (s: string) => createHash("sha256").update(Buffer.from(s)).digest();

/** Abre o voto testando os jeitos de escrever o nosso número e o da pessoa (número ou LID): só o certo passa no GCM. */
function openVote(vote: { encPayload?: Uint8Array | null; encIv?: Uint8Array | null }, pollMsgId: string, key: Buffer, creators: string[], voters: string[]) {
  if (!vote.encPayload || !vote.encIv) return null;
  for (const pollCreatorJid of creators)
    for (const voterJid of voters) {
      try {
        return decryptPollVote({ encPayload: vote.encPayload, encIv: vote.encIv }, { pollCreatorJid, pollMsgId, pollEncKey: key, voterJid });
      } catch {
        /* outra combinação */
      }
    }
  return null;
}

const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)).map((j) => jidNormalizedUser(j)))];

/**
 * Voto numa enquete nossa: devolve "sim" ou "não" para entrar como mensagem da pessoa, ou null para ignorar
 * (enquete de outra pessoa, voto retirado, enquete velha ou já respondida).
 */
export async function pollVoteText(sock: WASocket, raw: WAMessage, log: Log): Promise<string | null> {
  const upd = normalizeMessageContent(raw.message)?.pollUpdateMessage;
  const pollId = upd?.pollCreationMessageKey?.id;
  if (!upd?.vote || !pollId || raw.key.fromMe) return null;
  const poll = await one<{ secret: string; options: string[]; answered: boolean; valid: boolean }>(
    `SELECT secret, options, answered_at IS NOT NULL AS answered,
            created_at > now() - make_interval(mins => $2)
            AND NOT EXISTS (SELECT 1 FROM wa_polls n WHERE n.remote_jid = p.remote_jid AND n.created_at > p.created_at) AS valid
       FROM wa_polls p WHERE message_id = $1`,
    [pollId, POLL_MINUTES],
  );
  if (!poll) return null;
  const k = raw.key as WAMessage["key"] & { remoteJidAlt?: string; participantAlt?: string; senderPn?: string };
  const creators = uniq([sock.user?.id, sock.user?.lid]);
  const voters = uniq([k.participant, k.participantAlt, k.remoteJid, k.remoteJidAlt, k.senderPn]);
  const vote = openVote(upd.vote, pollId, Buffer.from(poll.secret, "base64"), creators, voters);
  if (!vote) {
    log.warn({ pollId }, "não consegui abrir o voto da enquete");
    return null;
  }
  const picked = (vote.selectedOptions ?? []).map((o) => Buffer.from(o));
  const choice = poll.options.find((name) => picked.some((h) => h.equals(sha(name))));
  if (!choice) return null; // voto retirado
  if (poll.answered || !poll.valid) {
    await sock.sendMessage(raw.key.remoteJid!, { text: "Essa confirmação já não vale mais. Se ainda quiser, é só me pedir de novo." }).catch(() => {});
    return null;
  }
  // marca antes de seguir: trocar o voto depois não dispara nada de novo
  const claimed = await query("UPDATE wa_polls SET answered_at = now() WHERE message_id = $1 AND answered_at IS NULL", [pollId]);
  if (!claimed.rowCount) return null;
  return choice === POLL_YES ? "sim" : "não";
}
