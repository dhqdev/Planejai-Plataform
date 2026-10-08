import type { WASocket } from "baileys";
import { safeFetch } from "../net.js";
import { isConnectionError, whatsapp, type WhatsAppSession } from "../whatsapp/session.js";
import type { Channel, InboundMessage, OutboundImage } from "./types.js";

/** quanto um envio espera a conexão voltar (religação em andamento) antes de desistir */
const SEND_WAIT_MS = 45_000;
/** "digitando...", lido e reação são acessórios: esperam pouco */
const EXTRA_WAIT_MS = 5_000;

/** Canal WhatsApp embutido (Baileys). Usa o socket do processo que segura a conexão (o worker). */
export class BaileysChannel implements Channel {
  id = "baileys";

  constructor(private session: WhatsAppSession = whatsapp) {}

  configured() {
    return true;
  }

  /**
   * Roda um envio no socket. Com a conexão caída, espera ela voltar (a sessão religa na hora);
   * se o socket morrer no meio do envio, derruba, religa e tenta mais uma vez.
   */
  private async run<T>(fn: (s: WASocket) => Promise<T>, waitMs = SEND_WAIT_MS): Promise<T> {
    const s = await this.session.ready(waitMs);
    try {
      return await fn(s);
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      this.session.reportBroken(s, err);
      return fn(await this.session.ready(waitMs));
    }
  }

  parseWebhook(): InboundMessage[] {
    return []; // mensagens chegam pelo socket, não por webhook
  }

  async downloadMedia(msg: InboundMessage) {
    return msg.media?.base64 ? { base64: msg.media.base64, mimetype: msg.media.mimetype } : null;
  }

  async sendText(jid: string, text: string, opts?: { quotedId?: string }) {
    const r = await this.run((s) =>
      s.sendMessage(
        jid,
        { text },
        opts?.quotedId ? { quoted: { key: { remoteJid: jid, id: opts.quotedId, fromMe: false }, message: { conversation: "" } } } : undefined,
      ),
    );
    return { id: r?.key?.id ?? undefined };
  }

  async sendImage(jid: string, image: OutboundImage) {
    // URL de fora é baixada aqui, só da internet pública (net.ts), em vez de a biblioteca buscar sozinha
    const content = image.base64 ? Buffer.from(image.base64, "base64") : await downloadMedia(image.url!);
    const r = await this.run((s) =>
      image.kind === "document"
        ? s.sendMessage(jid, { document: content, caption: image.caption, mimetype: image.mimetype ?? "application/pdf", fileName: image.fileName ?? "arquivo.pdf" })
        : image.kind === "video"
        ? s.sendMessage(jid, { video: content, caption: image.caption, mimetype: image.mimetype ?? "video/mp4" })
        : s.sendMessage(jid, { image: content, caption: image.caption, mimetype: image.mimetype }),
    );
    return { id: r?.key?.id ?? undefined };
  }

  async react(jid: string, messageId: string, emoji: string) {
    await this.run((s) => s.sendMessage(jid, { react: { text: emoji, key: { remoteJid: jid, id: messageId, fromMe: false } } }), EXTRA_WAIT_MS);
  }

  /** um "paused" pendente por conversa: chamar de novo renova o "digitando..." em vez de piscar */
  private pauseTimers = new Map<string, NodeJS.Timeout>();

  async setTyping(jid: string, ms: number) {
    const s = await this.session.ready(EXTRA_WAIT_MS);
    clearTimeout(this.pauseTimers.get(jid));
    await s.sendPresenceUpdate("composing", jid);
    const t = setTimeout(() => {
      this.pauseTimers.delete(jid);
      void s.sendPresenceUpdate("paused", jid).catch(() => {});
    }, ms);
    t.unref();
    this.pauseTimers.set(jid, t);
  }

  async markRead(jid: string, messageId: string) {
    await this.run((s) => s.readMessages([{ remoteJid: jid, id: messageId, fromMe: false }]), EXTRA_WAIT_MS);
  }
}

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

async function downloadMedia(url: string) {
  const res = await safeFetch(url, { signal: AbortSignal.timeout(60_000), headers: { "User-Agent": "Mozilla/5.0 (compatible; PlanejaiBot/1.0)" } });
  if (!res.ok) throw new Error(`Arquivo não abriu (${res.status})`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_MEDIA_BYTES) throw new Error("Arquivo grande demais (máx. 25 MB)");
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_MEDIA_BYTES) throw new Error("Arquivo grande demais (máx. 25 MB)");
  return data;
}
