import { getCredentials } from "../integrations/registry.js";
import type { Channel, InboundKind, InboundMessage, OutboundImage } from "./types.js";

const API = "https://api.telegram.org";

/** WhatsApp usa *negrito*, _itálico_, ~riscado~ e ```mono```; no Telegram isso vira HTML. */
export function toTelegramHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/```([\s\S]+?)```/g, "<pre>$1</pre>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, "$1<b>$2</b>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])~([^~\n]+)~(?=$|[\s).,!?:;])/g, "$1<s>$2</s>");
}

/**
 * Bot do Telegram (Bot API). Um bot só, do dono da stack: cada pessoa liga a conta dela pelo painel
 * (link t.me/bot?start=CODIGO) ou mandando o próprio contato no bot. O token fica em Integrações.
 */
export class TelegramChannel implements Channel {
  id = "telegram";
  private token = "";

  configured() {
    return Boolean(this.token);
  }

  async ready() {
    const c = await getCredentials("telegram");
    this.token = c?.bot_token ?? "";
    return this.token;
  }

  async call(method: string, body: Record<string, unknown> | FormData, timeoutMs = 30_000) {
    const token = await this.ready();
    if (!token) throw new Error("Telegram não configurado (Integrações > Telegram)");
    const isForm = body instanceof FormData;
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: isForm ? undefined : { "Content-Type": "application/json" },
      body: isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
  }

  parseWebhook(update: any): InboundMessage[] {
    const m = update?.message;
    if (!m || m.chat?.type !== "private" || m.from?.is_bot) return [];
    let kind: InboundKind = "text";
    let text: string = m.text ?? m.caption ?? "";
    let media: InboundMessage["media"];
    const file = (f: any, mimetype: string, fileName?: string) => ({ providerId: f.file_id, mimetype: f.mime_type ?? mimetype, fileName: fileName ?? f.file_name });
    if (m.photo?.length) {
      kind = "image";
      media = file(m.photo[m.photo.length - 1], "image/jpeg");
    } else if (m.voice) {
      kind = "audio";
      media = file(m.voice, "audio/ogg");
    } else if (m.audio) {
      kind = "audio";
      media = file(m.audio, "audio/mpeg");
    } else if (m.video || m.video_note) {
      kind = "video";
      media = file(m.video ?? m.video_note, "video/mp4");
    } else if (m.document) {
      kind = "document";
      media = file(m.document, "application/octet-stream");
    } else if (m.sticker) {
      kind = "sticker";
      text = m.sticker.emoji ?? "";
    } else if (m.location) {
      kind = "location";
      text = `Localização: ${m.location.latitude}, ${m.location.longitude}`;
    } else if (m.contact) {
      kind = "other";
      text = `Contato: ${[m.contact.first_name, m.contact.last_name].filter(Boolean).join(" ")} +${String(m.contact.phone_number).replace(/\D/g, "")}`;
    } else if (!m.text) {
      kind = "other";
    }
    const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || m.from?.username;
    return [
      {
        channel: this.id,
        remoteJid: String(m.chat.id),
        // o telefone vem da ligação da conta (channel_links); quem recebe o update preenche
        phone: "",
        pushName: name,
        externalId: String(m.message_id),
        kind,
        text,
        media,
        quoted: m.reply_to_message ? { id: String(m.reply_to_message.message_id), text: m.reply_to_message.text ?? m.reply_to_message.caption } : undefined,
        timestamp: new Date((m.date ?? Date.now() / 1000) * 1000),
        raw: update,
      },
    ];
  }

  async downloadMedia(msg: InboundMessage) {
    if (!msg.media?.providerId) return msg.media?.base64 ? { base64: msg.media.base64, mimetype: msg.media.mimetype } : null;
    const f = await this.call("getFile", { file_id: msg.media.providerId });
    const res = await fetch(`${API}/file/bot${this.token}/${f.file_path}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    return { base64: Buffer.from(await res.arrayBuffer()).toString("base64"), mimetype: msg.media.mimetype };
  }

  async sendText(chatId: string, text: string, opts?: { quotedId?: string }) {
    const body: Record<string, unknown> = { chat_id: chatId, text: toTelegramHtml(text), parse_mode: "HTML", link_preview_options: { is_disabled: false } };
    if (opts?.quotedId) body.reply_parameters = { message_id: Number(opts.quotedId), allow_sending_without_reply: true };
    try {
      const r = await this.call("sendMessage", body);
      return { id: String(r.message_id) };
    } catch {
      // HTML mal formado (asterisco solto etc.): manda como texto puro
      const r = await this.call("sendMessage", { chat_id: chatId, text });
      return { id: String(r.message_id) };
    }
  }

  async sendImage(chatId: string, image: OutboundImage) {
    const kind = image.kind ?? "image";
    const [method, field] =
      kind === "video" ? ["sendVideo", "video"]
      : kind === "document" ? ["sendDocument", "document"]
      : kind === "audio" ? (image.ptt ? ["sendVoice", "voice"] : ["sendAudio", "audio"])
      : ["sendPhoto", "photo"];
    const caption = image.caption ? toTelegramHtml(image.caption).slice(0, 1024) : undefined;
    let r: any;
    if (image.base64) {
      const form = new FormData();
      form.set("chat_id", chatId);
      if (caption) {
        form.set("caption", caption);
        form.set("parse_mode", "HTML");
      }
      const name = image.fileName ?? (kind === "video" ? "video.mp4" : kind === "document" ? "arquivo" : kind === "audio" ? (image.ptt ? "voz.ogg" : "audio.mp3") : "imagem.png");
      form.set(field, new Blob([Buffer.from(image.base64, "base64")], { type: image.mimetype ?? "application/octet-stream" }), name);
      r = await this.call(method, form, 120_000);
    } else {
      r = await this.call(method, { chat_id: chatId, [field]: image.url, caption, parse_mode: caption ? "HTML" : undefined }, 120_000);
    }
    return { id: String(r.message_id) };
  }

  async react(chatId: string, messageId: string, emoji: string) {
    // o Telegram só aceita uma lista fixa de emojis como reação; se não der, segue sem reagir
    await this.call("setMessageReaction", { chat_id: chatId, message_id: Number(messageId), reaction: [{ type: "emoji", emoji }] }).catch(() => {});
  }

  async setTyping(chatId: string) {
    await this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  }

  async markRead() {}
}
