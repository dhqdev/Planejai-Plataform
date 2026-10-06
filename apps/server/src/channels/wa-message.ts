import type { InboundKind, InboundMessage } from "./types.js";

/**
 * Converte uma WAMessage (formato do Baileys, usado também pela Evolution API) em InboundMessage.
 * Retorna null para grupos, status, canais e mensagens enviadas por nós.
 */
export function parseWAMessage(d: any, channel: string): InboundMessage | null {
  const key = d?.key;
  if (!key || key.fromMe) return null;
  const jid: string = key.remoteJid ?? "";
  if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@newsletter") || jid.endsWith("@broadcast")) return null;
  // Contas com LID: o número real vem em remoteJidAlt/senderPn
  const pnJid = [key.remoteJidAlt, key.senderPn, jid].find((j: string | undefined) => j?.endsWith("@s.whatsapp.net")) ?? jid;
  const phone = pnJid.split("@")[0]!.split(":")[0]!.replace(/\D/g, "");

  // Mensagens efêmeras / view once vêm embrulhadas
  let m = d.message ?? {};
  m = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m;

  let kind: InboundKind = "other";
  let text = "";
  let media: InboundMessage["media"];
  let reactionTo: string | undefined;
  const ctx = m.extendedTextMessage?.contextInfo ?? m.imageMessage?.contextInfo ?? m.audioMessage?.contextInfo ?? m.videoMessage?.contextInfo;
  if (m.conversation != null || m.extendedTextMessage) {
    kind = "text";
    text = m.conversation ?? m.extendedTextMessage?.text ?? "";
  } else if (m.imageMessage) {
    kind = "image";
    text = m.imageMessage.caption ?? "";
    media = { mimetype: m.imageMessage.mimetype ?? "image/jpeg" };
  } else if (m.audioMessage) {
    kind = "audio";
    media = { mimetype: m.audioMessage.mimetype ?? "audio/ogg" };
  } else if (m.videoMessage) {
    kind = "video";
    text = m.videoMessage.caption ?? "";
    media = { mimetype: m.videoMessage.mimetype ?? "video/mp4" };
  } else if (m.documentMessage || m.documentWithCaptionMessage) {
    const doc = m.documentMessage ?? m.documentWithCaptionMessage?.message?.documentMessage ?? {};
    kind = "document";
    text = doc.caption ?? "";
    media = { mimetype: doc.mimetype ?? "application/octet-stream", fileName: doc.fileName };
  } else if (m.stickerMessage) {
    kind = "sticker";
  } else if (m.locationMessage) {
    kind = "location";
    text = `Localização: ${m.locationMessage.degreesLatitude}, ${m.locationMessage.degreesLongitude}${m.locationMessage.name ? ` (${m.locationMessage.name})` : ""}`;
  } else if (m.reactionMessage) {
    kind = "reaction";
    text = m.reactionMessage.text ?? "";
    reactionTo = m.reactionMessage.key?.id;
  } else if (m.buttonsResponseMessage || m.listResponseMessage) {
    kind = "text";
    text = m.buttonsResponseMessage?.selectedDisplayText ?? m.listResponseMessage?.title ?? "";
  } else {
    // protocolo, edição, apagamento etc.: nada para responder
    return null;
  }
  if (media && d.message?.base64) media.base64 = d.message.base64;
  return {
    channel,
    remoteJid: jid,
    phone,
    pushName: d.pushName ?? undefined,
    externalId: key.id,
    kind,
    text,
    media,
    reactionTo,
    quoted: ctx?.stanzaId ? { id: ctx.stanzaId, text: ctx.quotedMessage?.conversation ?? ctx.quotedMessage?.extendedTextMessage?.text } : undefined,
    timestamp: d.messageTimestamp ? new Date(Number(d.messageTimestamp?.toNumber?.() ?? d.messageTimestamp) * 1000) : new Date(),
    raw: d,
  };
}
