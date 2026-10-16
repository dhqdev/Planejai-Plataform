import { jidNormalizedUser, proto, type AnyMessageContent, type WASocket } from "baileys";
import { safeFetch } from "../net.js";
import { callChannel, holdsWhatsApp } from "../whatsapp/rpc.js";
import { isConnectionError, whatsapp, type WhatsAppSession } from "../whatsapp/session.js";
import type { Channel, InboundMessage, OutboundImage, OutboundPoll, OutboundStatus } from "./types.js";

/** quanto um envio espera a conexão voltar (religação em andamento) antes de desistir */
const SEND_WAIT_MS = 45_000;
/** "digitando...", lido e reação são acessórios: esperam pouco */
const EXTRA_WAIT_MS = 5_000;
/** status vai criptografado para cada aparelho de cada pessoa da lista: com muita gente demora */
const STATUS_WAIT_MS = 120_000;

/**
 * Canal WhatsApp embutido (Baileys). No processo que segura a conexão (ROLE channel/worker/all) usa o socket
 * direto; nos outros (ROLE=conversations) cada envio vai ao channel pela fila whatsapp.send (whatsapp/rpc.ts).
 */
export class BaileysChannel implements Channel {
  id = "baileys";
  rich = true;

  constructor(
    private session: WhatsAppSession = whatsapp,
    private readonly remote = !holdsWhatsApp(),
  ) {}

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
    if (this.remote) return { id: (await callChannel({ op: "text", jid, text, quotedId: opts?.quotedId }, SEND_WAIT_MS)).id };
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
    if (this.remote) return { id: (await callChannel({ op: "media", jid, image }, SEND_WAIT_MS)).id };
    // URL de fora é baixada aqui, só da internet pública (net.ts), em vez de a biblioteca buscar sozinha
    const card = cardContent(image);
    if (card) {
      const r = await this.run((s) => s.sendMessage(jid, card));
      return { id: r?.key?.id ?? undefined };
    }
    const content = image.base64 ? Buffer.from(image.base64, "base64") : await downloadMedia(image.url!);
    const r = await this.run((s) =>
      image.kind === "document"
        ? s.sendMessage(jid, { document: content, caption: image.caption, mimetype: image.mimetype ?? "application/pdf", fileName: image.fileName ?? "arquivo.pdf" })
        : image.kind === "sticker"
        ? s.sendMessage(jid, { sticker: content })
        : image.kind === "video"
        ? s.sendMessage(jid, { video: content, caption: image.caption, mimetype: image.mimetype ?? "video/mp4", gifPlayback: image.gif || undefined })
        : image.kind === "audio"
        ? s.sendMessage(jid, { audio: content, mimetype: image.mimetype ?? "audio/ogg; codecs=opus", ptt: image.ptt ?? true, seconds: image.seconds || undefined })
        : s.sendMessage(jid, { image: content, caption: image.caption, mimetype: image.mimetype }),
    );
    return { id: r?.key?.id ?? undefined };
  }

  /** Troca o texto de uma mensagem nossa (o WhatsApp mostra "Editada"; vale até 15 min depois do envio). */
  async editText(jid: string, messageId: string, text: string) {
    if (this.remote) return void (await callChannel({ op: "edit", jid, messageId, text }, SEND_WAIT_MS));
    await this.run((s) => s.sendMessage(jid, { text, edit: { remoteJid: jid, id: messageId, fromMe: true } }));
  }

  /** Apaga para todos uma mensagem nossa. */
  async deleteMessage(jid: string, messageId: string) {
    if (this.remote) return void (await callChannel({ op: "delete", jid, messageId }, SEND_WAIT_MS));
    await this.run((s) => s.sendMessage(jid, { delete: { remoteJid: jid, id: messageId, fromMe: true } }));
  }

  async pinMessage(jid: string, messageId: string, days: 1 | 7 | 30) {
    if (this.remote) return void (await callChannel({ op: "pin", jid, messageId, days }, SEND_WAIT_MS));
    const time = days === 30 ? 2592000 : days === 1 ? 86400 : 604800;
    await this.run((s) => s.sendMessage(jid, { pin: { remoteJid: jid, id: messageId, fromMe: true }, type: proto.PinInChat.Type.PIN_FOR_ALL, time }));
  }

  /** Álbum: a mensagem-mãe diz quantas fotos e vídeos vêm, e cada mídia aponta para ela. */
  async sendAlbum(jid: string, items: OutboundImage[]) {
    if (this.remote) return { ids: (await callChannel({ op: "album", jid, items }, SEND_WAIT_MS * 2)).ids ?? [] };
    const files = await Promise.all(items.map((i) => (i.base64 ? Buffer.from(i.base64, "base64") : downloadMedia(i.url!))));
    const videos = items.filter((i) => i.kind === "video").length;
    const parent = await this.run((s) => s.sendMessage(jid, { album: { expectedImageCount: items.length - videos, expectedVideoCount: videos } }));
    const ids: (string | undefined)[] = [];
    for (const [n, item] of items.entries()) {
      const r = await this.run((s) =>
        s.sendMessage(
          jid,
          item.kind === "video"
            ? { video: files[n]!, caption: item.caption, mimetype: item.mimetype ?? "video/mp4", albumParentKey: parent?.key }
            : { image: files[n]!, caption: item.caption, mimetype: item.mimetype, albumParentKey: parent?.key },
        ),
      );
      ids.push(r?.key?.id ?? undefined);
    }
    return { ids };
  }

  async sendPoll(jid: string, poll: OutboundPoll) {
    if (this.remote) return { id: (await callChannel({ op: "poll", jid, poll }, SEND_WAIT_MS)).id };
    const r = await this.run((s) =>
      s.sendMessage(jid, { poll: { name: poll.name, values: poll.values, selectableCount: 1, messageSecret: Buffer.from(poll.secret, "base64") } }),
    );
    return { id: r?.key?.id ?? undefined };
  }

  async react(jid: string, messageId: string, emoji: string) {
    if (this.remote) return void (await callChannel({ op: "react", jid, messageId, emoji }, EXTRA_WAIT_MS));
    await this.run((s) => s.sendMessage(jid, { react: { text: emoji, key: { remoteJid: jid, id: messageId, fromMe: false } } }), EXTRA_WAIT_MS);
  }

  /**
   * Status do número (status@broadcast). O WhatsApp só entrega para quem está em statusJidList; o próprio número
   * entra na lista para o post aparecer no celular do dono.
   */
  async postStatus(status: OutboundStatus, jids: string[]) {
    if (this.remote) return { id: (await callChannel({ op: "status", status, jids }, STATUS_WAIT_MS)).id };
    const media = status.base64 ? Buffer.from(status.base64, "base64") : null;
    const r = await this.run((s) => {
      const me = s.user?.id ? jidNormalizedUser(s.user.id) : null;
      const opts = { statusJidList: [...new Set([...(me ? [me] : []), ...jids])], broadcast: true, backgroundColor: status.backgroundColor, font: status.font };
      if (status.kind === "text") return s.sendMessage("status@broadcast", { text: status.text ?? "" }, opts);
      if (!media) throw new Error("status sem foto nem vídeo");
      return status.kind === "video"
        ? s.sendMessage("status@broadcast", { video: media, caption: status.caption, mimetype: status.mimetype ?? "video/mp4" }, opts)
        : s.sendMessage("status@broadcast", { image: media, caption: status.caption, mimetype: status.mimetype }, opts);
    }, STATUS_WAIT_MS);
    return { id: r?.key?.id ?? undefined };
  }

  /** um "paused" pendente por conversa: chamar de novo renova o "digitando..." em vez de piscar */
  private pauseTimers = new Map<string, NodeJS.Timeout>();

  async setTyping(jid: string, ms: number, kind: "typing" | "recording" = "typing") {
    if (this.remote) return void (await callChannel({ op: "typing", jid, ms, kind }, EXTRA_WAIT_MS));
    const s = await this.session.ready(EXTRA_WAIT_MS);
    clearTimeout(this.pauseTimers.get(jid));
    await s.sendPresenceUpdate(kind === "recording" ? "recording" : "composing", jid);
    const t = setTimeout(() => {
      this.pauseTimers.delete(jid);
      void s.sendPresenceUpdate("paused", jid).catch(() => {});
    }, ms);
    t.unref();
    this.pauseTimers.set(jid, t);
  }

  async markRead(jid: string, messageId: string) {
    if (this.remote) return void (await callChannel({ op: "read", jid, messageId }, EXTRA_WAIT_MS));
    await this.run((s) => s.readMessages([{ remoteJid: jid, id: messageId, fromMe: false }]), EXTRA_WAIT_MS);
  }
}

/** Cartão nativo (evento, localização, contato) no formato do Baileys, ou null se é mídia comum. */
export function cardContent(m: OutboundImage): AnyMessageContent | null {
  if (m.kind === "event" && m.event) {
    return {
      event: {
        name: m.event.name.slice(0, 100),
        description: m.event.description?.slice(0, 500),
        startDate: new Date(m.event.start),
        endDate: m.event.end ? new Date(m.event.end) : undefined,
        location: m.event.location ? { name: m.event.location.slice(0, 200) } : undefined,
      },
    };
  }
  if (m.kind === "location" && m.location) {
    return { location: { degreesLatitude: m.location.lat, degreesLongitude: m.location.lng, name: m.location.name, address: m.location.address } };
  }
  if (m.kind === "contact" && m.contact) {
    const digits = m.contact.phone.replace(/\D/g, "");
    const name = m.contact.name.replace(/[\r\n;]/g, " ").trim();
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL;type=VOICE;waid=${digits}:+${digits}\nEND:VCARD`;
    return { contacts: { displayName: name, contacts: [{ displayName: name, vcard }] } };
  }
  return null;
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
