import { downloadMediaMessage, type WAMessage, type WASocket } from "baileys";
import pino from "pino";
import { parseWAMessage } from "../channels/wa-message.js";
import { query } from "../db/pool.js";
import { ingest } from "../ingest.js";
import { SESSION_ID, type Log } from "./types.js";

const MEDIA_MAX_BYTES = 20 * 1024 * 1024;

/** Mensagem que chegou pelo socket: baixa a mídia e entrega para o ingest. */
export async function handleIncoming(sock: WASocket, raw: WAMessage, log: Log) {
  const msg = parseWAMessage(raw, "baileys");
  if (!msg) return;
  void query("UPDATE wa_sessions SET last_message_at = now() WHERE id = $1", [SESSION_ID]).catch(() => {});
  // Baixa a mídia já na chegada (a mídia do WhatsApp expira e o socket só existe aqui)
  if (msg.media && ["audio", "image", "document", "video"].includes(msg.kind)) {
    try {
      const buf = await downloadMediaMessage(raw, "buffer", {}, { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage });
      if (buf.length <= MEDIA_MAX_BYTES) msg.media.base64 = buf.toString("base64");
    } catch (err) {
      log.warn({ err }, "não consegui baixar a mídia");
    }
  }
  await ingest(msg);
}
