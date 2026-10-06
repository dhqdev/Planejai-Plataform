import { config } from "../config.js";
import type { Channel, InboundKind, InboundMessage, OutboundImage } from "./types.js";

/** Adaptador para a Evolution API v2 (WhatsApp via Baileys, self-hosted). */
export class EvolutionChannel implements Channel {
  id = "evolution";

  configured() {
    return Boolean(config.EVOLUTION_API_URL && config.EVOLUTION_API_KEY && config.EVOLUTION_INSTANCE);
  }

  private async call(path: string, body: unknown) {
    const url = `${config.EVOLUTION_API_URL.replace(/\/$/, "")}${path}/${encodeURIComponent(config.EVOLUTION_INSTANCE)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { apikey: config.EVOLUTION_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Evolution ${path} ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  parseWebhook(body: any): InboundMessage[] {
    const event = String(body?.event ?? "").toLowerCase().replace("_", ".");
    if (event !== "messages.upsert") return [];
    const items = Array.isArray(body.data) ? body.data : [body.data];
    const out: InboundMessage[] = [];
    for (const d of items) {
      const key = d?.key;
      if (!key || key.fromMe) continue;
      const jid: string = key.remoteJid ?? "";
      if (jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@newsletter")) continue;
      // Contas com LID: o número real vem em remoteJidAlt/senderPn
      const pnJid = [key.remoteJidAlt, key.senderPn, jid].find((j: string | undefined) => j?.endsWith("@s.whatsapp.net")) ?? jid;
      const phone = pnJid.split("@")[0]!.replace(/\D/g, "");
      const m = d.message ?? {};
      let kind: InboundKind = "other";
      let text = "";
      let media: InboundMessage["media"];
      let reactionTo: string | undefined;
      const ctx = m.extendedTextMessage?.contextInfo ?? m.imageMessage?.contextInfo ?? m.audioMessage?.contextInfo;
      if (m.conversation || m.extendedTextMessage) {
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
      }
      if (media && m.base64) media.base64 = m.base64;
      out.push({
        channel: this.id,
        remoteJid: jid,
        phone,
        pushName: d.pushName,
        externalId: key.id,
        kind,
        text,
        media,
        reactionTo,
        quoted: ctx?.stanzaId
          ? { id: ctx.stanzaId, text: ctx.quotedMessage?.conversation ?? ctx.quotedMessage?.extendedTextMessage?.text }
          : undefined,
        timestamp: d.messageTimestamp ? new Date(Number(d.messageTimestamp) * 1000) : new Date(),
        raw: d,
      });
    }
    return out;
  }

  async downloadMedia(msg: InboundMessage) {
    if (msg.media?.base64) return { base64: msg.media.base64, mimetype: msg.media.mimetype };
    const r = await this.call("/chat/getBase64FromMediaMessage", {
      message: { key: { id: msg.externalId, remoteJid: msg.remoteJid, fromMe: false } },
      convertToMp4: false,
    });
    if (!r?.base64) return null;
    return { base64: r.base64 as string, mimetype: (r.mimetype as string) ?? msg.media?.mimetype ?? "application/octet-stream" };
  }

  async sendText(remoteJid: string, text: string, opts?: { quotedId?: string }) {
    const body: any = { number: remoteJid, text };
    if (opts?.quotedId) body.quoted = { key: { id: opts.quotedId } };
    const r = await this.call("/message/sendText", body);
    return { id: r?.key?.id };
  }

  async sendImage(remoteJid: string, image: OutboundImage) {
    const r = await this.call("/message/sendMedia", {
      number: remoteJid,
      mediatype: "image",
      mimetype: image.mimetype ?? "image/png",
      caption: image.caption ?? "",
      media: image.base64 ?? image.url,
      fileName: image.fileName ?? "imagem.png",
    });
    return { id: r?.key?.id };
  }

  async react(remoteJid: string, messageId: string, emoji: string) {
    await this.call("/message/sendReaction", { key: { remoteJid, fromMe: false, id: messageId }, reaction: emoji });
  }

  async setTyping(remoteJid: string, ms: number) {
    await this.call("/chat/sendPresence", { number: remoteJid, delay: ms, presence: "composing" });
  }

  async markRead(remoteJid: string, messageId: string) {
    await this.call("/chat/markMessageAsRead", { readMessages: [{ remoteJid, fromMe: false, id: messageId }] });
  }
}
