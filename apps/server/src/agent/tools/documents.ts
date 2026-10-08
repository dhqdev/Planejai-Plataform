import { config } from "../../config.js";
import { deleteDocument, getDocument, listDocuments, saveDocument } from "../../documents.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

/** Pasta de documentos da pessoa: guardar o que ela mandou, achar e devolver quando pedir. */

const panel = () => `${config.PUBLIC_URL.replace(/\/$/, "")}/documentos`;

export const documentSave = defineTool<{ name?: string; folder?: string; notes?: string; all?: boolean }>({
  name: "document_save",
  description:
    "Guarda na pasta de Documentos da pessoa o arquivo (PDF, foto, planilha) que ela acabou de mandar nesta conversa. " +
    "Use quando ela pedir para guardar/salvar ('guarda esse PDF', 'salva meu RG'). name: nome claro (ex.: 'Contrato aluguel 2026.pdf'); folder opcional (ex.: Documentos pessoais, Contas, Saúde).",
  parameters: obj({
    name: { type: "string" },
    folder: { type: "string" },
    notes: { type: "string", description: "Uma linha do que é, para achar depois" },
    all: { type: "boolean", description: "true guarda todos os arquivos desta rodada" },
  }),
  async run(args, ctx) {
    const files = ctx.inboundFiles ?? [];
    if (!files.length) return { error: "Nenhum arquivo nesta conversa agora. Peça para a pessoa mandar o arquivo de novo e guardar junto." };
    const pick = args.all ? files : [files.at(-1)!];
    const saved = [];
    for (const [i, f] of pick.entries()) {
      const name = args.name && pick.length === 1 ? args.name : args.name ? `${args.name} ${i + 1}` : f.fileName ?? "documento";
      const doc = await saveDocument({ userId: ctx.user.id, name, mimetype: f.mimetype, data: Buffer.from(f.base64, "base64"), folder: args.folder, notes: args.notes, source: "whatsapp" });
      saved.push({ id: doc.id, name: doc.name, folder: doc.folder, size_kb: Math.round(doc.size / 1024) });
    }
    return { ok: true, saved, painel: panel() };
  },
});

export const documentList = defineTool<{ query?: string; folder?: string }>({
  name: "document_list",
  description: "Procura nos documentos guardados da pessoa (nome, pasta, nota). Devolve id, nome, pasta e data.",
  parameters: obj({ query: { type: "string" }, folder: { type: "string" } }),
  async run(args, ctx) {
    const rows = await listDocuments(ctx.user.id, { q: args.query, folder: args.folder });
    return { total: rows.length, documents: rows.slice(0, 30).map((d) => ({ id: d.id, name: d.name, folder: d.folder, notes: d.notes, size_kb: Math.round(d.size / 1024), saved_at: d.created_at })), painel: panel() };
  },
});

export const documentSend = defineTool<{ id: string; caption?: string }>({
  name: "document_send",
  description: "Manda para a pessoa um documento guardado (id de document_list). Retorna media_id para pôr na resposta com [[media:ID]].",
  parameters: obj({ id: { type: "string" }, caption: { type: "string" } }, ["id"]),
  async run(args, ctx) {
    const d = await getDocument(args.id, ctx.user.id);
    if (!d) return { error: "Documento não encontrado" };
    const kind = d.mimetype.startsWith("image/") ? "image" : "document";
    const id = ctx.outbox.addMedia({ kind, base64: d.data.toString("base64"), mimetype: d.mimetype, fileName: d.name, caption: args.caption });
    return { media_id: id, name: d.name, how_to_send: `Coloque [[media:${id}]] na resposta.` };
  },
});

export const documentDelete = defineTool<{ id: string; confirmed_by_user?: boolean }>({
  name: "document_delete",
  description: "Apaga um documento guardado. Pede o \"sim\" da pessoa (o sistema confirma sozinho).",
  parameters: obj({ id: { type: "string" }, ...CONFIRM_PARAM }, ["id"]),
  async run(args, ctx) {
    const d = await getDocument(args.id, ctx.user.id);
    if (!d) return { error: "Documento não encontrado" };
    const blocked = await requireConfirmation(args, `apagar o documento ${d.name}`, ctx);
    if (blocked) return blocked;
    await deleteDocument(args.id, ctx.user.id);
    return { ok: true, deleted: d.name };
  },
});
