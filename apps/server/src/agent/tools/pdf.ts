import { saveDocument } from "../../documents.js";
import { PDF_LIMITS, type PdfSpec, pdfFileName, renderPdf } from "../../pdf.js";
import { defineTool, obj } from "./types.js";

export const makePdf = defineTool<PdfSpec>({
  name: "make_pdf",
  description:
    "PDF A4 de várias páginas com o conteúdo que VOCÊ escreve (sem custo de imagem): capa, sumário e seções com text " +
    "(parágrafos separados por linha em branco, **negrito**), items, table e highlight. Para relatório, apostila, roteiro, plano. " +
    "Fica guardado em Documentos. Devolve media_id para [[media:ID]].",
  parameters: obj(
    {
      title: { type: "string" },
      subtitle: { type: "string" },
      author: { type: "string" },
      sections: {
        type: "array",
        description: `Até ${PDF_LIMITS.sections}`,
        items: obj(
          {
            title: { type: "string" },
            text: { type: "string" },
            items: { type: "array", items: { type: "string" } },
            table: obj({ columns: { type: "array", items: { type: "string" } }, rows: { type: "array", items: { type: "array", items: { type: "string" } } } }, ["columns", "rows"]),
            highlight: { type: "string", description: "Dica ou resumo em destaque" },
          },
          ["title"],
        ),
      },
    },
    ["title", "sections"],
  ),
  async run(args, ctx) {
    if (!args.sections?.some((s) => s?.title && (s.text || s.items?.length || s.table?.rows?.length || s.highlight)))
      return { ok: false, error: "Mande sections com o conteúdo (text, items ou table)." };
    const data = await renderPdf(args);
    const fileName = pdfFileName(args.title);
    // guarda em Documentos para a pessoa achar depois; se não couber, o PDF vai do mesmo jeito
    const saved = await saveDocument({ userId: ctx.user.id, name: fileName, mimetype: "application/pdf", data, folder: "Feitos pelo assistente", source: "assistente" }).catch(() => null);
    const id = ctx.outbox.addMedia({ kind: "document", base64: data.toString("base64"), mimetype: "application/pdf", fileName });
    return { media_id: id, file: fileName, size_kb: Math.round(data.length / 1024), saved_in_documents: Boolean(saved), how_to_send: `Coloque [[media:${id}]] na resposta, com uma frase curta.` };
  },
});
