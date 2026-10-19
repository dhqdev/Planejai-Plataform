import { downloadMediaMessage, normalizeMessageContent, type WAMessage, type WASocket } from "baileys";
import pino from "pino";
import { parseWAMessage } from "../channels/wa-message.js";
import { query } from "../db/pool.js";
import { ingest } from "../ingest.js";
import { pollVoteText } from "./polls.js";
import { SESSION_ID, type Log } from "./types.js";

const MEDIA_MAX_BYTES = 20 * 1024 * 1024;

/** Mensagem que chegou pelo socket: baixa a mídia e entrega para o ingest. */
export async function handleIncoming(sock: WASocket, raw: WAMessage, log: Log) {
  // voto na enquete do "sim": entra como se a pessoa tivesse escrito "sim" ou "não"
  if (raw.message && !raw.key.fromMe && normalizeMessageContent(raw.message)?.pollUpdateMessage) {
    const text = await pollVoteText(sock, raw, log);
    if (!text) return;
    raw = { ...raw, message: { conversation: text } };
  }
  const msg = parseWAMessage(raw, "baileys");
  if (!msg) return;
  void query("UPDATE wa_sessions SET last_message_at = now() WHERE id = $1", [SESSION_ID]).catch(() => {});
  // Baixa a mídia já na chegada (a mídia do WhatsApp expira e o socket só existe aqui)
  // figurinha também: quando é resposta de um recado, ela é encaminhada de verdade para quem mandou
  if (msg.media && ["audio", "image", "document", "video", "sticker"].includes(msg.kind)) {
    // encaminhada costuma ter link velho: a segunda tentativa pede o reenvio da mídia ao WhatsApp
    for (let attempt = 0; attempt < 2 && !msg.media.base64; attempt++) {
      try {
        const buf = await downloadMediaMessage(raw, "buffer", {}, { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage });
        if (buf.length <= MEDIA_MAX_BYTES) msg.media.base64 = buf.toString("base64");
        break;
      } catch (err) {
        log.warn({ err, attempt, forwarded: msg.forwarded }, "não consegui baixar a mídia");
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  await ingest(msg);
}
