import { config } from "../config.js";
import { BaileysChannel } from "./baileys.js";
import { CloudChannel } from "./cloud.js";
import { EvolutionChannel } from "./evolution.js";
import type { Channel, InboundMessage, OutboundImage } from "./types.js";

export const channels: Record<string, Channel> = {
  baileys: new BaileysChannel(),
  evolution: new EvolutionChannel(),
  cloud: new CloudChannel(),
};

/** Canal de teste do dashboard (Playground): guarda o que seria enviado em vez de mandar pro WhatsApp. */
export class PlaygroundChannel implements Channel {
  id = "playground";
  sent: { type: "text" | "image" | "reaction"; text?: string; image?: OutboundImage; emoji?: string; messageId?: string }[] = [];
  configured() {
    return true;
  }
  parseWebhook(): InboundMessage[] {
    return [];
  }
  async downloadMedia(msg: InboundMessage) {
    return msg.media?.base64 ? { base64: msg.media.base64, mimetype: msg.media.mimetype } : null;
  }
  async sendText(_to: string, text: string) {
    this.sent.push({ type: "text", text });
    return { id: `pg-${Date.now()}-${this.sent.length}` };
  }
  async sendImage(_to: string, image: OutboundImage) {
    this.sent.push({ type: "image", image });
    return {};
  }
  async react(_to: string, messageId: string, emoji: string) {
    this.sent.push({ type: "reaction", emoji, messageId });
  }
  async setTyping() {}
  async markRead() {}
}

export const playground = new PlaygroundChannel();
channels.playground = playground;

export function activeChannel(): Channel | null {
  if (config.WHATSAPP_PROVIDER === "none") return null;
  return channels[config.WHATSAPP_PROVIDER] ?? null;
}

export function getChannel(id: string): Channel {
  const c = channels[id];
  if (!c) throw new Error(`Canal desconhecido: ${id}`);
  return c;
}
