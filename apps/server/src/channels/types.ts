export type InboundKind = "text" | "image" | "audio" | "video" | "document" | "sticker" | "location" | "reaction" | "other";

export interface InboundMedia {
  mimetype: string;
  /** base64 já disponível no webhook (Evolution com webhook_base64) */
  base64?: string;
  /** id da mídia no provedor, para baixar depois */
  providerId?: string;
  fileName?: string;
}

export interface InboundMessage {
  channel: string;
  remoteJid: string;
  phone: string;
  pushName?: string;
  externalId: string;
  kind: InboundKind;
  text: string;
  media?: InboundMedia;
  quoted?: { id: string; text?: string };
  /** para reações: id da mensagem que recebeu a reação */
  reactionTo?: string;
  timestamp: Date;
  raw: unknown;
}

export interface OutboundImage {
  /** padrão "image" */
  kind?: "image" | "video" | "document" | "audio";
  base64?: string;
  url?: string;
  mimetype?: string;
  caption?: string;
  fileName?: string;
  /** áudio: true = mensagem de voz (bolinha do WhatsApp), Ogg/Opus */
  ptt?: boolean;
  seconds?: number;
  /** áudio: o texto falado, para a memória curta saber o que foi dito */
  spoken?: string;
}

export interface Channel {
  id: string;
  configured(): boolean;
  parseWebhook(body: any): InboundMessage[];
  downloadMedia(msg: InboundMessage): Promise<{ base64: string; mimetype: string } | null>;
  sendText(remoteJid: string, text: string, opts?: { quotedId?: string }): Promise<{ id?: string }>;
  sendImage(remoteJid: string, image: OutboundImage): Promise<{ id?: string }>;
  react(remoteJid: string, messageId: string, emoji: string): Promise<void>;
  setTyping(remoteJid: string, ms: number): Promise<void>;
  markRead(remoteJid: string, messageId: string): Promise<void>;
}
