import { saveDocument } from "../../documents.js";
import { PDF_LIMITS, type PdfSection, type PdfSpec, normalizePdfSpec, pdfFileName, renderPdf } from "../../pdf.js";
import { parseJsonObject, writeLong } from "../writer.js";
import { type ToolContext, defineTool, obj } from "./types.js";

type PdfArgs = PdfSpec & { brief?: string };

const hasContent = (spec: PdfSpec) => spec.sections.some((s) => s.text || s.items?.length || s.table?.rows?.length || s.highlight);

// Texto simples em vez de JSON: no JSON uma aspa sem escape ou um corte no fim perdia o documento inteiro
// ("Expected ',' or ']'..."). Aqui cada linha vale sozinha e um corte só perde o fim.
const WRITER = `Você escreve o conteúdo de um PDF A4 em português do Brasil, a partir do pedido. Responda só o texto, neste formato:
SUBTÍTULO: uma linha
## Título da seção
Parágrafos separados por linha em branco, **negrito** quando ajuda.
- item de lista
> dica ou resumo em destaque
| coluna | coluna |
| valor | valor |
Texto de verdade, completo e organizado (uma seção por assunto, 4 a 10 seções, no máximo umas 2500 palavras), sem inventar números ou citações. Listas, tabela e destaque só quando ajudam.`;

/** Lê o texto do redator (## seções, - itens, > destaque, | tabela |). Tolera corte no fim e JSON antigo. */
export function parseWriterText(text: string): PdfSpec {
  const t = text.replace(/^```\w*\n?|```\s*$/g, "").trim();
  if (t.startsWith("{")) {
    try {
      return normalizePdfSpec(parseJsonObject(t));
    } catch {
      /* segue como texto */
    }
  }
  let subtitle: string | undefined;
  const sections: PdfSection[] = [];
  let cur: { title: string; text: string[]; items: string[]; highlight: string[]; rows: string[][] } | null = null;
  const flush = () => {
    if (!cur) return;
    const rows = cur.rows.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c)));
    const [columns, ...body] = rows;
    sections.push({
      title: cur.title,
      text: cur.text.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
      items: cur.items.length ? cur.items : undefined,
      highlight: cur.highlight.join(" ").trim() || undefined,
      table: columns && body.length ? { columns, rows: body } : undefined,
    });
  };
  for (const raw of t.split("\n")) {
    const line = raw.trim();
    const sub = /^SUBT[IÍ]TULO:\s*(.+)/i.exec(line);
    if (sub && !cur) subtitle = sub[1]!.trim();
    else if (/^#{1,3}\s+/.test(line)) {
      flush();
      cur = { title: line.replace(/^#+\s+/, "").replace(/\*\*/g, ""), text: [], items: [], highlight: [], rows: [] };
    } else {
      cur ??= { title: "Introdução", text: [], items: [], highlight: [], rows: [] };
      if (/^[-*•]\s+/.test(line)) cur.items.push(line.replace(/^[-*•]\s+/, ""));
      else if (line.startsWith(">")) cur.highlight.push(line.replace(/^>\s*/, ""));
      else if (/^\|.*\|$/.test(line)) cur.rows.push(line.slice(1, -1).split("|").map((c) => c.trim()));
      else cur.text.push(line);
    }
  }
  flush();
  return normalizePdfSpec({ subtitle, sections: sections.filter((s) => s.text || s.items || s.table || s.highlight) });
}

/** Escreve as seções numa chamada própria (writeLong): o agente manda só título e brief. */
async function writeSections(args: PdfArgs, ctx: ToolContext): Promise<PdfSpec> {
  const ask = [`Título: ${args.title}`, args.subtitle && `Subtítulo: ${args.subtitle}`, args.brief && `Pedido: ${args.brief}`].filter(Boolean).join("\n");
  const spec = { ...parseWriterText(await writeLong(ctx, { name: "texto do PDF", system: WRITER, ask, maxTokens: 6000 })), title: args.title };
  return { ...spec, subtitle: args.subtitle || spec.subtitle, author: args.author };
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
      try {
        args = await writeSections({ ...args, brief: [brief, outline.length ? `Seções: ${outline.join("; ")}` : ""].filter(Boolean).join("\n") }, ctx);
      } catch (err) {
        const slow = /timeout|abort/i.test(String(err));
        return { ok: false, error: `${slow ? "O redator demorou demais" : "O redator falhou"}. Não tente de novo nesta resposta: avise a pessoa e ofereça um PDF mais curto ou tentar mais tarde.` };
      }
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
