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
  /**
   * padrão "image"; "sticker" = figurinha webp 512x512. "event", "location" e "contact" são cartões nativos do WhatsApp
   * (só canais com `rich`); nos outros sai `fallbackText`.
   */
  kind?: "image" | "video" | "document" | "audio" | "sticker" | "event" | "location" | "contact";
  base64?: string;
  url?: string;
  mimetype?: string;
  caption?: string;
  fileName?: string;
  /** áudio: true = mensagem de voz (bolinha do WhatsApp), Ogg/Opus */
  ptt?: boolean;
  /** vídeo curto que roda em loop, sem som (GIF do WhatsApp) */
  gif?: boolean;
  seconds?: number;
  /** áudio: o texto falado, para a memória curta saber o que foi dito */
  spoken?: string;
  /** convite de evento do WhatsApp (Vou / Não vou); datas em ISO */
  event?: { name: string; description?: string; start: string; end?: string; location?: string };
  /** pino de localização */
  location?: { lat: number; lng: number; name?: string; address?: string };
  /** cartão de contato */
  contact?: { name: string; phone: string };
  /** o que vai em texto quando o canal não tem o cartão nativo (e o que entra na memória curta) */
  fallbackText?: string;
}

export const RICH_KINDS = new Set(["event", "location", "contact"]);

/** Enquete do WhatsApp (uma escolha só): usada para o "sim" das ações sensíveis */
export interface OutboundPoll {
  name: string;
  values: string[];
  /** chave de 32 bytes em base64 que abre os votos (guardada em wa_polls) */
  secret: string;
}

/** Status do WhatsApp (some em 24 h): foto ou vídeo com legenda, ou texto num fundo colorido. */
export interface OutboundStatus {
  kind: "image" | "video" | "text";
  /** foto ou vídeo */
  base64?: string;
  mimetype?: string;
  caption?: string;
  /** status de texto */
  text?: string;
  /** cor de fundo do status de texto (#RRGGBB) e fonte (0 a 5 no WhatsApp) */
  backgroundColor?: string;
  font?: number;
}

export interface Channel {
  id: string;
  configured(): boolean;
  parseWebhook(body: any): InboundMessage[];
  downloadMedia(msg: InboundMessage): Promise<{ base64: string; mimetype: string } | null>;
  sendText(remoteJid: string, text: string, opts?: { quotedId?: string }): Promise<{ id?: string }>;
  sendImage(remoteJid: string, image: OutboundImage): Promise<{ id?: string }>;
  /** só canais que mandam enquete (Baileys); sem ele a pergunta vai em texto */
  sendPoll?(remoteJid: string, poll: OutboundPoll): Promise<{ id?: string }>;
  react(remoteJid: string, messageId: string, emoji: string): Promise<void>;
  /** "digitando..." ou, antes de um áudio, "gravando áudio..." */
  setTyping(remoteJid: string, ms: number, kind?: "typing" | "recording"): Promise<void>;
  markRead(remoteJid: string, messageId: string): Promise<void>;
  /** manda cartões nativos (evento, localização, contato), edita, apaga, fixa e agrupa fotos em álbum (Baileys) */
  rich?: boolean;
  editText?(remoteJid: string, messageId: string, text: string): Promise<void>;
  deleteMessage?(remoteJid: string, messageId: string): Promise<void>;
  /** fixa uma mensagem nossa no topo da conversa por 1, 7 ou 30 dias */
  pinMessage?(remoteJid: string, messageId: string, days: 1 | 7 | 30): Promise<void>;
  /** várias fotos (e vídeos) num álbum só; devolve o id de cada uma */
  sendAlbum?(remoteJid: string, items: OutboundImage[]): Promise<{ ids: (string | undefined)[] }>;
  /** só Baileys: posta um status do número para as pessoas da lista */
  postStatus?(status: OutboundStatus, jids: string[]): Promise<{ id?: string }>;
}
