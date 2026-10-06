import { config } from "../config.js";
import type { Channel, InboundMessage, OutboundImage } from "./types.js";
import { parseWAMessage } from "./wa-message.js";

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
    return items.map((d: any) => parseWAMessage(d, this.id)).filter((m: InboundMessage | null): m is InboundMessage => m !== null);
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
