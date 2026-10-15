import { promptText } from "../prompt-overrides.js";
import { saveDocument } from "../../documents.js";
import { PDF_LIMITS, type PdfImages, type PdfSection, type PdfSpec, chartNumber, normalizePdfSpec, pdfFileName, renderPdf } from "../../pdf.js";
import { downloadFirst, searchPictureUrls } from "./images.js";
import { parseJsonObject, writeLong } from "../writer.js";
import { type ToolContext, defineTool, obj } from "./types.js";

type PdfArgs = PdfSpec & { brief?: string };

const hasContent = (spec: PdfSpec) => spec.sections.some((s) => s.text || s.items?.length || s.table?.rows?.length || s.highlight || s.stats?.length || s.chart);

// Texto simples em vez de JSON: no JSON uma aspa sem escape ou um corte no fim perdia o documento inteiro
// ("Expected ',' or ']'..."). Aqui cada linha vale sozinha e um corte só perde o fim.
export const WRITER = `Você escreve o conteúdo de um PDF A4 em português do Brasil, a partir do pedido. Responda só o texto, neste formato:
SUBTÍTULO: uma linha
CAPA: busca curta da foto da capa (algo concreto que aparece em foto: o livro, o lugar, o prato, o esporte)
## Título da seção
IMAGEM: busca curta de uma foto real que ajuda nesta seção
NÚMERO: valor | o que ele significa
Parágrafos separados por linha em branco, **negrito** quando ajuda.
- item de lista
> dica ou resumo em destaque
>! cuidado ou risco que a pessoa precisa saber
GRÁFICO: título | rótulo: número; rótulo: número
| coluna | coluna |
| valor | valor |
Texto de verdade, completo e organizado (uma seção por assunto, 4 a 10 seções, no máximo umas 2500 palavras), sem inventar números ou citações.
Fotos: CAPA quando o assunto tem imagem concreta e IMAGEM em 2 a 4 seções, nunca em todas; busca em poucas palavras, sem pessoas reais desconhecidas.
NÚMERO (2 a 4 por seção, no máximo em 2 seções) e GRÁFICO só com números reais que vieram do pedido ou que são fatos conhecidos. Listas, tabela e destaques só quando ajudam.`;

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
  let coverImage: string | undefined;
  const sections: PdfSection[] = [];
  type Cur = { title: string; text: string[]; items: string[]; highlight: string[]; warning: string[]; rows: string[][]; image?: string; stats: { value: string; label: string }[]; chart?: PdfSection["chart"] };
  const fresh = (title: string): Cur => ({ title, text: [], items: [], highlight: [], warning: [], rows: [], stats: [] });
  let cur: Cur | null = null;
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
      ...(cur.warning.length ? { warning: cur.warning.join(" ").trim() } : {}),
      ...(cur.image ? { image: cur.image } : {}),
      ...(cur.stats.length ? { stats: cur.stats } : {}),
      ...(cur.chart ? { chart: cur.chart } : {}),
    });
  };
  for (const raw of t.split("\n")) {
    const line = raw.trim();
    const sub = /^SUBT[IÍ]TULO:\s*(.+)/i.exec(line);
    const capa = /^CAPA:\s*(.+)/i.exec(line);
    if (sub && !cur) subtitle = sub[1]!.trim();
    else if (capa && !cur) coverImage = capa[1]!.trim();
    else if (/^#{1,3}\s+/.test(line)) {
      flush();
      cur = fresh(line.replace(/^#+\s+/, "").replace(/\*\*/g, ""));
    } else {
      cur ??= fresh("Introdução");
      const img = /^IMAGEM:\s*(.+)/i.exec(line);
      const num = /^N[ÚU]MERO:\s*(.+)/i.exec(line);
      const chart = /^GR[ÁA]FICO:\s*(.+)/i.exec(line);
      if (img) cur.image ??= img[1]!.trim();
      else if (num) {
        const [value, ...label] = num[1]!.split("|");
        if (value?.trim()) cur.stats.push({ value: value.trim(), label: label.join("|").trim() });
      } else if (chart) cur.chart ??= parseChart(chart[1]!);
      else if (/^[-*•]\s+/.test(line)) cur.items.push(line.replace(/^[-*•]\s+/, ""));
      else if (line.startsWith(">!")) cur.warning.push(line.replace(/^>!\s*/, ""));
      else if (line.startsWith(">")) cur.highlight.push(line.replace(/^>\s*/, ""));
      else if (/^\|.*\|$/.test(line)) cur.rows.push(line.slice(1, -1).split("|").map((c) => c.trim()));
      else cur.text.push(line);
    }
  }
  flush();
  const spec = normalizePdfSpec({ subtitle, sections: sections.filter((s) => s.text || s.items || s.table || s.highlight || s.warning || s.stats || s.chart) });
  return coverImage ? { ...spec, coverImage } : spec;
}

/** "Gastos do mês | Mercado: 450; Luz: 120,50" -> gráfico de barras (só as barras com número). */
function parseChart(t: string): PdfSection["chart"] | undefined {
  const [head, rest] = t.includes("|") ? [t.slice(0, t.indexOf("|")), t.slice(t.indexOf("|") + 1)] : ["", t];
  const bars = rest
    .split(";")
    .map((p) => {
      const i = p.lastIndexOf(":");
      if (i < 0) return null;
      const label = p.slice(0, i).trim();
      const text = p.slice(i + 1).trim();
      const value = chartNumber(text);
      return label && value != null ? { label, value, text } : null;
    })
    .filter((b): b is { label: string; value: number; text: string } => Boolean(b));
  return bars.length >= 2 ? { title: head.trim() || undefined, bars } : undefined;
}

/** Escreve as seções numa chamada própria (writeLong): o agente manda só título e brief. */
async function writeSections(args: PdfArgs, ctx: ToolContext): Promise<PdfSpec> {
  const ask = [`Título: ${args.title}`, args.subtitle && `Subtítulo: ${args.subtitle}`, args.brief && `Pedido: ${args.brief}`].filter(Boolean).join("\n");
  const spec = { ...parseWriterText(await writeLong(ctx, { name: "texto do PDF", system: await promptText("redator_pdf", WRITER), ask, maxTokens: 8000 })), title: args.title };
  return { ...spec, subtitle: args.subtitle || spec.subtitle, author: args.author, coverImage: args.coverImage || spec.coverImage };
}

/** Por foto: até 1,5 MB (o PDF fica leve e o navegador da stack aceita o HTML). */
const PDF_PHOTO_BYTES = 1.5 * 1024 * 1024;

/**
 * Baixa as fotos pedidas (capa e até 4 seções) em paralelo pela busca de imagens da stack (Tavily ou Brave).
 * Tudo com prazo: o que não chegar a tempo fica de fora e o PDF sai do mesmo jeito.
 */
export async function fetchPdfImages(spec: PdfSpec, ctx: ToolContext, budgetMs = 25_000): Promise<PdfImages> {
  const wanted: { key: "cover" | number; q: string }[] = [];
  if (spec.coverImage) wanted.push({ key: "cover", q: spec.coverImage });
  spec.sections.forEach((s, i) => {
    if (s.image && wanted.filter((w) => w.key !== "cover").length < PDF_LIMITS.images) wanted.push({ key: i, q: s.image });
  });
  const out: PdfImages = { sections: {} };
  if (!wanted.length) return out;
  const step = await ctx.tracer.step({ agent: "imagem", type: "tool", name: "fotos do PDF", parentId: ctx.parentStepId, input: { buscas: wanted.map((w) => w.q) } });
  const used = new Set<string>();
  const one = async (w: (typeof wanted)[number]) => {
    const urls = (await searchPictureUrls(w.q.slice(0, 120)).catch(() => [])).filter((u) => !used.has(u));
    const img = await downloadFirst(urls, PDF_PHOTO_BYTES);
    if (!img || used.has(img.url)) return;
    used.add(img.url);
    let credit: string | undefined;
    try {
      credit = new URL(img.url).hostname.replace(/^www\./, "");
    } catch {
      /* sem crédito */
    }
    const pic = { src: `data:${img.mimetype};base64,${img.base64}`, credit };
    if (w.key === "cover") out.cover = pic;
    else out.sections[w.key] = pic;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.allSettled(wanted.map(one)), new Promise((r) => (timer = setTimeout(r, budgetMs)))]);
  clearTimeout(timer);
  // foto que chegar depois do prazo não entra (o objeto já foi lido)
  const got = { cover: Boolean(out.cover), sections: Object.keys(out.sections).length };
  await step.ok(got);
  return { cover: out.cover, sections: { ...out.sections } };
}

export const makePdf = defineTool<PdfArgs>({
  name: "make_pdf",
  description:
    "PDF A4 bonito de várias páginas (capa com foto, sumário, seções com fotos reais, números, gráfico, tabelas, dicas), guardado em Documentos. Para resumo de livro, relatório, apostila, roteiro, plano: " +
    "mande title e brief (o que o PDF deve cobrir, tópicos, tom, tamanho e dados da conversa que precisam entrar) e a ferramenta escreve o texto. " +
    "Só mande sections quando você já tem o conteúdo pronto e curto (ex.: números da conversa). Devolve media_id para [[media:ID]].",
  parameters: obj(
    {
      title: { type: "string" },
      brief: { type: "string", description: "O que escrever: assunto, tópicos, tom, tamanho, dados da conversa" },
      subtitle: { type: "string" },
      author: { type: "string" },
      cover_image: { type: "string", description: "Busca curta da foto da capa (o livro, o lugar, o assunto)" },
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
            warning: { type: "string", description: "Cuidado ou risco em destaque" },
            image: { type: "string", description: "Busca curta de uma foto real para a seção (no máximo 4 no PDF)" },
            stats: { type: "array", description: "Até 4 números reais em cartões", items: obj({ value: { type: "string" }, label: { type: "string" } }, ["value"]) },
            chart: obj({ title: { type: "string" }, bars: { type: "array", items: obj({ label: { type: "string" }, value: { type: "number" } }, ["label", "value"]) } }, ["bars"]),
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
    const images = await fetchPdfImages(args, ctx).catch(() => ({ sections: {} }) as PdfImages);
    const data = await renderPdf(args, images);
    const fileName = pdfFileName(args.title);
    // guarda em Documentos para a pessoa achar depois; se não couber, o PDF vai do mesmo jeito
    const saved = await saveDocument({ userId: ctx.user.id, name: fileName, mimetype: "application/pdf", data, folder: "Feitos pelo assistente", source: "assistente" }).catch(() => null);
    const id = ctx.outbox.addMedia({ kind: "document", base64: data.toString("base64"), mimetype: "application/pdf", fileName });
    return { media_id: id, file: fileName, sections: args.sections.length, saved_in_documents: Boolean(saved), how_to_send: `Coloque [[media:${id}]] na resposta, com uma frase curta.` };
  },
});
