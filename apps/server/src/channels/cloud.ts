import { config } from "../config.js";
import type { Channel, InboundKind, InboundMessage, OutboundImage } from "./types.js";

const GRAPH = "https://graph.facebook.com/v21.0";

/** Adaptador para a WhatsApp Cloud API oficial da Meta. */
export class CloudChannel implements Channel {
  id = "cloud";

  configured() {
    return Boolean(config.WHATSAPP_CLOUD_TOKEN && config.WHATSAPP_CLOUD_PHONE_NUMBER_ID);
  }

  private async send(body: Record<string, unknown>) {
    const res = await fetch(`${GRAPH}/${config.WHATSAPP_CLOUD_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.WHATSAPP_CLOUD_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
      signal: AbortSignal.timeout(30_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WhatsApp Cloud ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  }

  parseWebhook(body: any): InboundMessage[] {
    const out: InboundMessage[] = [];
    for (const entry of body?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const names = new Map<string, string>((value.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
        for (const m of value.messages ?? []) {
          let kind: InboundKind = "other";
          let text = "";
          let media: InboundMessage["media"];
          let reactionTo: string | undefined;
          switch (m.type) {
            case "text":
              kind = "text";
              text = m.text?.body ?? "";
              break;
            case "image":
            case "audio":
            case "video":
            case "document":
            case "sticker":
              kind = m.type;
              text = m[m.type]?.caption ?? "";
              media = { mimetype: m[m.type]?.mime_type ?? "application/octet-stream", providerId: m[m.type]?.id, fileName: m[m.type]?.filename };
              break;
            case "location":
              kind = "location";
              text = `Localização: ${m.location?.latitude}, ${m.location?.longitude}${m.location?.name ? ` (${m.location.name})` : ""}`;
              break;
            case "reaction":
              kind = "reaction";
              text = m.reaction?.emoji ?? "";
              reactionTo = m.reaction?.message_id;
              break;
            case "interactive":
              kind = "text";
              text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "";
              break;
            case "button":
              kind = "text";
              text = m.button?.text ?? "";
              break;
          }
          out.push({
            channel: this.id,
            remoteJid: m.from,
            phone: String(m.from).replace(/\D/g, ""),
            pushName: names.get(m.from),
            externalId: m.id,
            kind,
            text,
            media,
            reactionTo,
            quoted: m.context?.id ? { id: m.context.id } : undefined,
            timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
            raw: m,
          });
        }
      }
    }
    return out;
  }

  async downloadMedia(msg: InboundMessage) {
    const id = msg.media?.providerId;
    if (!id) return null;
    const auth = { Authorization: `Bearer ${config.WHATSAPP_CLOUD_TOKEN}` };
    const meta: any = await (await fetch(`${GRAPH}/${id}`, { headers: auth })).json();
    if (!meta?.url) return null;
    const bin = await fetch(meta.url, { headers: auth });
    const buf = Buffer.from(await bin.arrayBuffer());
    return { base64: buf.toString("base64"), mimetype: meta.mime_type ?? msg.media!.mimetype };
  }

  async sendText(to: string, text: string, opts?: { quotedId?: string }) {
    const r = await this.send({
      to,
      type: "text",
      text: { body: text, preview_url: true },
      ...(opts?.quotedId ? { context: { message_id: opts.quotedId } } : {}),
    });
    return { id: r?.messages?.[0]?.id };
  }

  private async upload(base64: string, mimetype: string, fileName: string) {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimetype);
    form.append("file", new Blob([Buffer.from(base64, "base64")], { type: mimetype }), fileName);
    const res = await fetch(`${GRAPH}/${config.WHATSAPP_CLOUD_PHONE_NUMBER_ID}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.WHATSAPP_CLOUD_TOKEN}` },
      body: form,
    });
    const json: any = await res.json();
    if (!res.ok) throw new Error(`Upload de mídia falhou: ${JSON.stringify(json).slice(0, 300)}`);
    return json.id as string;
  }

  async sendImage(to: string, image: OutboundImage) {
    const type = image.kind ?? "image";
    const img: Record<string, unknown> = { caption: image.caption };
    if (image.base64) img.id = await this.upload(image.base64, image.mimetype ?? (type === "video" ? "video/mp4" : "image/png"), image.fileName ?? (type === "video" ? "gravacao.mp4" : "imagem.png"));
    else img.link = image.url;
    const r = await this.send({ to, type, [type]: img });
    return { id: r?.messages?.[0]?.id };
  }

  async react(to: string, messageId: string, emoji: string) {
    await this.send({ recipient_type: "individual", to, type: "reaction", reaction: { message_id: messageId, emoji } });
  }

  // A Cloud API só mostra "digitando" junto com a confirmação de leitura de uma mensagem recebida.
  private lastInbound = new Map<string, string>();

  async markRead(to: string, messageId: string) {
    this.lastInbound.set(to, messageId);
    await this.send({ status: "read", message_id: messageId });
  }

  async setTyping(to: string) {
    const id = this.lastInbound.get(to);
    if (id) await this.send({ status: "read", message_id: id, typing_indicator: { type: "text" } });
  }
}
