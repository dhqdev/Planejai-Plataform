import { saveDocument } from "./documents.js";
import { isoLocal } from "./time.js";

/**
 * Arquivos que chegam nas conversas que o assistente tem pela pessoa (recados, conversas delegadas e respostas de
 * mensagens avulsas): PDF, documento, foto e vídeo vão para o WhatsApp da pessoa como vieram, ficam guardados em
 * Documentos (pasta "Recados") e aparecem no balão da conversa na tela Recados.
 */

export type ChatFileKind = "image" | "video" | "document";
export const CHAT_FILE_KINDS: readonly string[] = ["image", "video", "document"];
export const CHAT_FILE_FOLDER = "Recados";
/** Até 16 MB, o limite de mídia do WhatsApp para encaminhar. */
export const FORWARD_MAX_BYTES = 16 * 1024 * 1024;

export interface ChatFile {
  /** documento em Documentos; null quando não deu para guardar (espaço cheio, grande demais, não baixou) */
  doc_id: string | null;
  name: string;
  mimetype: string;
  kind: ChatFileKind;
  size: number;
  /** legenda que veio junto (o texto do balão na tela; a descrição da IA fica só para o agente) */
  caption?: string;
}

export const isChatFileKind = (kind: string | undefined): kind is ChatFileKind => Boolean(kind && CHAT_FILE_KINDS.includes(kind));

const EXT: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "video/mp4": ".mp4",
  "video/3gpp": ".3gp",
  "video/quicktime": ".mov",
};

const LABEL: Record<ChatFileKind, string> = { image: "Foto", video: "Vídeo", document: "Arquivo" };

/** "uma foto", "um vídeo", "um arquivo" (ou o nome do PDF) para o aviso no WhatsApp. */
export function fileLabel(f: Pick<ChatFile, "kind" | "name">, named = true) {
  if (f.kind === "image") return "uma foto";
  if (f.kind === "video") return "um vídeo";
  return named && f.name ? `o arquivo _${f.name}_` : "um arquivo";
}

/** Nome do arquivo: o que veio no WhatsApp ou "Foto de Petshop 2026-11-11 14h30.jpg". */
export function chatFileName(kind: ChatFileKind, mimetype: string, given: string | undefined, from: string, timezone: string) {
  const name = given?.trim();
  if (name) return name;
  const when = isoLocal(new Date(), timezone).replace("T", " ").replace(":", "h");
  const base = `${LABEL[kind]} de ${from} ${when}`.replace(/\s+/g, " ").slice(0, 100);
  return `${base}${EXT[mimetype.split(";")[0]!.trim().toLowerCase()] ?? ""}`;
}

/** Guarda o arquivo em Documentos da pessoa. Nunca derruba quem chamou: sem espaço, volta com doc_id null. */
export async function keepChatFile(
  userId: string,
  from: string,
  timezone: string,
  f: { kind: ChatFileKind; base64: string; mimetype: string; fileName?: string; caption?: string },
): Promise<ChatFile> {
  const data = Buffer.from(f.base64, "base64");
  const name = chatFileName(f.kind, f.mimetype, f.fileName, from, timezone);
  const doc = await saveDocument({ userId, name, mimetype: f.mimetype, data, folder: CHAT_FILE_FOLDER, notes: `Recebido de ${from}`.slice(0, 200), source: "recado" }).catch(() => null);
  const caption = f.caption?.trim().slice(0, 1000) || undefined;
  return { doc_id: doc?.id ?? null, name: doc?.name ?? name, mimetype: f.mimetype, kind: f.kind, size: data.length, ...(caption ? { caption } : {}) };
}

/** O que a tela recebe (sem nada além do necessário para mostrar e abrir). */
export function panelFile(f: ChatFile | null | undefined) {
  if (!f || !isChatFileKind(f.kind)) return undefined;
  return { doc_id: f.doc_id ?? null, name: String(f.name ?? ""), mimetype: String(f.mimetype ?? ""), kind: f.kind, size: Number(f.size) || 0 };
}
