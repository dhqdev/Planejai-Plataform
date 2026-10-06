import { whatsapp } from "../whatsapp/session.js";
import type { Channel, InboundMessage, OutboundImage } from "./types.js";

/** Canal WhatsApp embutido (Baileys). Usa o socket do processo que segura a conexão (o worker). */
export class BaileysChannel implements Channel {
  id = "baileys";

  configured() {
    return true;
  }

  private sock() {
    const s = whatsapp.sock;
    if (!s?.user) throw new Error("WhatsApp não está conectado. Conecte pelo dashboard (tela WhatsApp).");
    return s;
  }

  parseWebhook(): InboundMessage[] {
    return []; // mensagens chegam pelo socket, não por webhook
  }

  async downloadMedia(msg: InboundMessage) {
    return msg.media?.base64 ? { base64: msg.media.base64, mimetype: msg.media.mimetype } : null;
  }

  async sendText(jid: string, text: string, opts?: { quotedId?: string }) {
    const r = await this.sock().sendMessage(
      jid,
      { text },
      opts?.quotedId ? { quoted: { key: { remoteJid: jid, id: opts.quotedId, fromMe: false }, message: { conversation: "" } } } : undefined,
    );
    return { id: r?.key?.id ?? undefined };
  }

  async sendImage(jid: string, image: OutboundImage) {
    const content = image.base64 ? Buffer.from(image.base64, "base64") : { url: image.url! };
    const r = await this.sock().sendMessage(jid, { image: content, caption: image.caption, mimetype: image.mimetype });
    return { id: r?.key?.id ?? undefined };
  }

  async react(jid: string, messageId: string, emoji: string) {
    await this.sock().sendMessage(jid, { react: { text: emoji, key: { remoteJid: jid, id: messageId, fromMe: false } } });
  }

  async setTyping(jid: string, ms: number) {
    const s = this.sock();
    await s.sendPresenceUpdate("composing", jid);
    setTimeout(() => void s.sendPresenceUpdate("paused", jid).catch(() => {}), ms).unref();
  }

  async markRead(jid: string, messageId: string) {
    await this.sock().readMessages([{ remoteJid: jid, id: messageId, fromMe: false }]);
  }
}
