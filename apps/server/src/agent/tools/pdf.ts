import { saveDocument } from "../../documents.js";
import { chatCompletion } from "../../llm/openrouter.js";
import { resolveModel } from "../../llm/router.js";
import { PDF_LIMITS, type PdfSpec, normalizePdfSpec, pdfFileName, renderPdf } from "../../pdf.js";
import { type ToolContext, defineTool, obj } from "./types.js";

type PdfArgs = PdfSpec & { brief?: string };

const hasContent = (spec: PdfSpec) => spec.sections.some((s) => s.text || s.items?.length || s.table?.rows?.length || s.highlight);

const WRITER = `Você escreve o conteúdo de um PDF A4 em português do Brasil, a partir do pedido. Responda só JSON:
{"subtitle":"...","sections":[{"title":"...","text":"parágrafos separados por linha em branco, **negrito** quando ajuda","items":["..."],"highlight":"dica ou resumo"}]}
Texto de verdade, completo e organizado (uma seção por assunto, 4 a 10 seções), sem inventar números ou citações. items, table ({"columns":[],"rows":[[]]}) e highlight só quando ajudam.`;

/**
 * Escreve as seções numa chamada própria, com saída longa. O CTO tem teto de 1200 tokens: um documento inteiro
 * não cabe na chamada da ferramenta e o modelo acabava mandando só título e subtítulo, em loop.
 */
async function writeSections(args: PdfArgs, ctx: ToolContext): Promise<PdfSpec> {
  const ask = [`Título: ${args.title}`, args.subtitle && `Subtítulo: ${args.subtitle}`, args.brief && `Pedido: ${args.brief}`].filter(Boolean).join("\n");
  const step = await ctx.tracer.step({ agent: "pdf", type: "llm", name: "texto do PDF", parentId: ctx.parentStepId, input: { ask } });
  try {
    const r = await chatCompletion(await resolveModel("pdf_writer"), {
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: WRITER },
        { role: "user", content: ask.slice(0, 4000) },
      ],
    });
    const raw = String(r.message.content ?? "").replace(/^```(json)?|```$/g, "").trim();
    const spec = normalizePdfSpec({ ...JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)), title: args.title });
    await step.ok({ sections: spec.sections.length }, { model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd });
    return { ...spec, subtitle: args.subtitle || spec.subtitle, author: args.author };
  } catch (err) {
    await step.fail(err);
    throw err;
  }
}

export const makePdf = defineTool<PdfArgs>({
  name: "make_pdf",
  description:
    "PDF A4 de várias páginas (capa, sumário, seções, tabelas, destaques), guardado em Documentos. Para resumo de livro, relatório, apostila, roteiro, plano: " +
    "mande title e brief (o que o PDF deve cobrir, tópicos, tom, tamanho e dados da conversa que precisam entrar) e a ferramenta escreve o texto. " +
    "Só mande sections quando você já tem o conteúdo pronto e curto (ex.: números da conversa). Devolve media_id para [[media:ID]].",
  parameters: obj(
    {
      title: { type: "string" },
      brief: { type: "string", description: "O que escrever: assunto, tópicos, tom, tamanho, dados da conversa" },
      subtitle: { type: "string" },
      author: { type: "string" },
      sections: {
        type: "array",
        description: `Opcional, até ${PDF_LIMITS.sections}`,
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
    ["title"],
  ),
  async run(raw, ctx) {
    let args: PdfSpec = normalizePdfSpec(raw);
    if (!hasContent(args)) {
      const brief = typeof (raw as PdfArgs)?.brief === "string" ? (raw as PdfArgs).brief : undefined;
      // seções só com título viram roteiro para o redator
      const outline = args.sections.map((s) => s.title).filter((t) => !/^Parte \d+$/.test(t));
      args = await writeSections({ ...args, brief: [brief, outline.length ? `Seções: ${outline.join("; ")}` : ""].filter(Boolean).join("\n") }, ctx);
      if (!hasContent(args)) return { ok: false, error: "Não consegui escrever o conteúdo agora. Avise a pessoa e ofereça tentar de novo." };
    }
    const data = await renderPdf(args);
    const fileName = pdfFileName(args.title);
    // guarda em Documentos para a pessoa achar depois; se não couber, o PDF vai do mesmo jeito
    const saved = await saveDocument({ userId: ctx.user.id, name: fileName, mimetype: "application/pdf", data, folder: "Feitos pelo assistente", source: "assistente" }).catch(() => null);
    const id = ctx.outbox.addMedia({ kind: "document", base64: data.toString("base64"), mimetype: "application/pdf", fileName });
    return { media_id: id, file: fileName, sections: args.sections.length, saved_in_documents: Boolean(saved), how_to_send: `Coloque [[media:${id}]] na resposta, com uma frase curta.` };
  },
});
