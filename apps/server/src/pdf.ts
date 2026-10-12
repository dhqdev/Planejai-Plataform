import { htmlToPdf } from "./charts.js";
import { PDF_BASE_CSS, coverHtml, docFooter } from "./doc-theme.js";

/**
 * PDF de várias páginas sob pedido (relatório, apostila, roteiro, plano), no mesmo esquema do make_image:
 * a IA só manda o conteúdo em JSON, o layout (capa, sumário, seções, tabelas, destaques) é HTML montado aqui
 * e vira PDF A4 no navegador da stack. A paginação é do navegador, então cabe quanto texto vier.
 */

export interface PdfSection {
  title: string;
  /** parágrafos separados por linha em branco */
  text?: string;
  items?: string[];
  table?: { columns: string[]; rows: string[][] };
  /** caixa de destaque no fim da seção (dica, atenção, resumo) */
  highlight?: string;
}

export interface PdfSpec {
  title: string;
  subtitle?: string;
  author?: string;
  sections: PdfSection[];
}

export const PDF_LIMITS = { sections: 40, text: 6000, items: 30, cols: 6, rows: 60 } as const;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
/** **negrito** simples dentro do texto; o resto vai escapado */
const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
const paragraphs = (t: string) =>
  t
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${inline(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

const CSS = PDF_BASE_CSS;

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const parseMaybe = (v: unknown) => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

/**
 * O modelo nem sempre segue o formato: manda sections como texto JSON, chama o título de heading,
 * o texto de content/body ou parágrafos em lista, ou uma seção como string solta. Tudo vira PdfSpec.
 */
export function normalizePdfSpec(raw: unknown): PdfSpec {
  const a = (parseMaybe(raw) ?? {}) as Record<string, unknown>;
  let list = parseMaybe(a.sections ?? a.secoes ?? a.chapters ?? a.capitulos);
  if (!Array.isArray(list)) list = list && typeof list === "object" ? [list] : [];
  const sections = (list as unknown[]).map((x, i): PdfSection => {
    const v = parseMaybe(x);
    if (typeof v === "string") return { title: `Parte ${i + 1}`, text: v };
    const o = (v ?? {}) as Record<string, unknown>;
    const body = o.text ?? o.content ?? o.body ?? o.texto ?? o.conteudo ?? o.paragraphs ?? o.paragrafos;
    const items = parseMaybe(o.items ?? o.bullets ?? o.points ?? o.list ?? o.topicos);
    const table = parseMaybe(o.table ?? o.tabela) as PdfSection["table"] | undefined;
    return {
      title: str(o.title ?? o.heading ?? o.titulo ?? o.name) || `Parte ${i + 1}`,
      text: Array.isArray(body) ? body.map(str).filter(Boolean).join("\n\n") : str(body),
      items: Array.isArray(items) ? items.map(str).filter(Boolean) : undefined,
      table: table && Array.isArray(table.columns) && Array.isArray(table.rows) ? table : undefined,
      highlight: str(o.highlight ?? o.destaque ?? o.tip ?? o.dica) || undefined,
    };
  });
  // sem seções mas com texto solto: vira uma seção só
  if (!sections.length && str(a.text ?? a.content)) sections.push({ title: str(a.title) || "Documento", text: str(a.text ?? a.content) });
  return { title: str(a.title ?? a.titulo) || "Documento", subtitle: str(a.subtitle ?? a.subtitulo) || undefined, author: str(a.author) || undefined, sections };
}

/** Rodapé de cada página (o navegador numera): título à esquerda, "página X de Y" à direita. */
export function pdfFooter(title: string) {
  return docFooter(clip(title, 80));
}

export function buildPdfHtml(spec: PdfSpec, today = new Date()) {
  const L = PDF_LIMITS;
  const secs = (spec.sections ?? [])
    // modelo às vezes chama o título da seção de heading
    .map((s) => (s && !s.title && (s as { heading?: string }).heading ? { ...s, title: (s as { heading?: string }).heading! } : s))
    .filter((s) => s && s.title)
    .slice(0, L.sections)
    .map((s) => {
      const cols = (s.table?.columns ?? []).slice(0, L.cols).map((c) => clip(c, 60));
      return {
        title: clip(s.title, 120),
        text: s.text ? clip(s.text, L.text) : "",
        items: (s.items ?? []).slice(0, L.items).map((i) => clip(i, 400)),
        cols,
        rows: cols.length ? (s.table?.rows ?? []).slice(0, L.rows).map((r) => cols.map((_, i) => clip(r?.[i], 300))) : [],
        highlight: s.highlight ? clip(s.highlight, 800) : "",
      };
    });
  const date = today.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
  const n = (i: number) => String(i + 1).padStart(2, "0");

  const cover = coverHtml({
    kicker: secs.length > 1 ? `Documento · ${secs.length} partes` : "Documento",
    title: esc(clip(spec.title, 140)),
    subtitle: spec.subtitle ? esc(clip(spec.subtitle, 260)) : undefined,
    metaLeft: spec.author ? `Feito para ${esc(clip(spec.author, 80))}` : "Feito pelo seu assistente",
    metaRight: esc(date),
  });
  // sumário só quando ajuda a navegar
  const toc =
    secs.length >= 4
      ? `<div class="toc"><h2>Sumário</h2><ol>${secs.map((s, i) => `<li><span class="n">${n(i)}</span><span>${esc(s.title)}</span></li>`).join("")}</ol></div>`
      : "";
  const body = secs
    .map(
      (s, i) => `<section><h2><span class="n">${n(i)}</span><span>${esc(s.title)}</span></h2>
${paragraphs(s.text)}${s.items.length ? `<ul>${s.items.map((t) => `<li>${inline(t)}</li>`).join("")}</ul>` : ""}${
        s.cols.length && s.rows.length
          ? `<table><thead><tr>${s.cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${s.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
          : ""
      }${s.highlight ? `<div class="hl">${paragraphs(s.highlight)}</div>` : ""}</section>`,
    )
    .join("");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(clip(spec.title, 140))}</title><style>${CSS}</style></head><body>${cover}${toc}${body}</body></html>`;
}

/** Nome de arquivo limpo a partir do título: "Plano de estudos 2026.pdf". */
export function pdfFileName(title: string) {
  const base = clip(title, 70).replace(/…$/, "").replace(/[\\/:*?"<>|\n\r\t]+/g, " ").replace(/\s+/g, " ").trim();
  return `${base || "documento"}.pdf`;
}

export async function renderPdf(spec: PdfSpec): Promise<Buffer> {
  return htmlToPdf(buildPdfHtml(spec), pdfFooter(spec.title));
}
