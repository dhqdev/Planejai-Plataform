import { randomUUID } from "node:crypto";
import { attachmentLabel, type DirectAttachment } from "../../direct.js";
import { getDocument } from "../../documents.js";
import { cacheGet, cacheSet } from "../../shortmem.js";
import type { ToolContext } from "./types.js";

/**
 * Foto ou documento que vai junto numa mensagem para outra pessoa (send_to_contact, send_whatsapp), agora ou agendada.
 * - attach: o arquivo que ela mandou nesta rodada ou há pouco (a última mídia da conversa fica 30 min no Redis).
 * - document_id: um arquivo guardado em Documentos (inclusive os PDFs feitos pelo assistente).
 * O arquivo da conversa só existe na memória: até o "sim" ele fica no Redis e a pendência guarda só a chave (attach_key),
 * que o servidor escreve e confere pelo prefixo da conversa. O modelo não escolhe chave.
 */

/** Mesmo prazo da pendência do "sim". */
const TTL_S = 30 * 60;
/** JSON com base64: ~9 MB de arquivo. */
const MAX_CACHE = 12_000_000;

export const ATTACH_PARAMS = {
  attach: { type: "boolean", description: "Junta a foto/arquivo que ela mandou agora ou há pouco" },
  document_id: { type: "string", description: "Junta um arquivo de Documentos (id de document_list)" },
} as const;

export interface AttachArgs {
  attach?: boolean;
  /** nome antigo, ainda aceito */
  attach_photo?: boolean;
  document_id?: string;
  attach_key?: string;
  photo_key?: string;
}

type File = { base64: string; mimetype: string; fileName?: string };

const recentKey = (conversationId: string) => `recent-media:${conversationId}`;
const pendingPrefix = (conversationId: string) => `pending-attach:${conversationId}:`;

/** Guarda a última foto/arquivo que a pessoa mandou, para "manda isso pro João" na mensagem seguinte. */
export async function rememberInboundMedia(conversationId: string, files: File[] | undefined) {
  const last = files?.at(-1);
  if (last) await cacheSet(recentKey(conversationId), last, TTL_S, MAX_CACHE);
}

const toAttachment = (f: File): DirectAttachment => ({
  kind: f.mimetype.startsWith("image/") ? "image" : "document",
  base64: f.base64,
  mimetype: f.mimetype,
  fileName: f.fileName,
});

async function fromDocuments(id: string, ctx: ToolContext): Promise<{ att: DirectAttachment } | { error: string }> {
  const d = await getDocument(id, ctx.user.id);
  if (!d) return { error: "Documento não encontrado em Documentos (veja o id em document_list)." };
  return { att: toAttachment({ base64: d.data.toString("base64"), mimetype: d.mimetype, fileName: d.name }) };
}

/**
 * Antes do "sim": acha o arquivo e devolve os args que ficam guardados na pendência (com a chave do Redis).
 * Depois do "sim" (ctx.approvedAction): busca o arquivo pela chave guardada.
 */
export async function resolveAttachment(
  args: AttachArgs,
  ctx: ToolContext,
): Promise<{ att: DirectAttachment | null; stored: Record<string, unknown>; label: string } | { error: string }> {
  const { attach_key, photo_key, ...clean } = args as AttachArgs & Record<string, unknown>;
  const wants = Boolean(args.attach || args.attach_photo);
  if (!wants && !args.document_id) return { att: null, stored: clean, label: "" };
  const prefix = pendingPrefix(ctx.conversation.id);

  if (ctx.approvedAction) {
    if (args.document_id) {
      const r = await fromDocuments(args.document_id, ctx);
      return "error" in r ? r : { att: r.att, stored: clean, label: attachmentLabel({ kind: r.att.kind, name: r.att.fileName }) };
    }
    // pendências antigas guardavam a foto em pending-photo:<conversa>:
    const key = [attach_key, photo_key].find(
      (k): k is string => typeof k === "string" && (k.startsWith(prefix) || k.startsWith(`pending-photo:${ctx.conversation.id}:`)),
    );
    const file = key ? await cacheGet<File>(key) : null;
    if (!file) return { error: "O arquivo venceu antes do sim e nada foi enviado. Peça para ela mandar a foto/arquivo de novo." };
    const att = toAttachment(file);
    return { att, stored: clean, label: attachmentLabel({ kind: att.kind, name: att.fileName }) };
  }

  if (args.document_id) {
    const r = await fromDocuments(args.document_id, ctx);
    return "error" in r ? r : { att: r.att, stored: clean, label: attachmentLabel({ kind: r.att.kind, name: r.att.fileName }) };
  }
  const file = ctx.inboundFiles?.at(-1) ?? (await cacheGet<File>(recentKey(ctx.conversation.id)));
  if (!file) return { error: "Não achei foto nem arquivo recente nesta conversa. Peça para ela mandar o arquivo (ou use document_id de Documentos)." };
  const key = prefix + randomUUID();
  if (!(await cacheSet(key, file, TTL_S, MAX_CACHE))) return { error: "Não consegui guardar o arquivo agora (grande demais ou falha momentânea). Se for grande, guarde em Documentos e use document_id." };
  const att = toAttachment(file);
  return { att, stored: { ...clean, attach_key: key }, label: attachmentLabel({ kind: att.kind, name: att.fileName }) };
}

/** Mostra para a pessoa, junto da pergunta do "sim", a foto/arquivo exatamente como vai sair. */
export function previewAttachment(ctx: ToolContext, att: DirectAttachment, caption: string) {
  ctx.outbox?.addMedia({ kind: att.kind, base64: att.base64, mimetype: att.mimetype, fileName: att.fileName, caption: caption.slice(0, 1000) });
}
