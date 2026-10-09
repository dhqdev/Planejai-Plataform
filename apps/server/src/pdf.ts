import { PALETTE, htmlToPdf } from "./charts.js";

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

const CSS = `
@page{size:A4;margin:22mm 18mm 22mm}
*{box-sizing:border-box}
html,body{margin:0;background:#fff}
body{font-family:Inter,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#141414;font-size:11pt;line-height:1.55;-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.bar{width:56px;height:7px;border-radius:4px;background:linear-gradient(90deg,#6510E0,#C42BEA)}
.cover{height:245mm;display:flex;flex-direction:column;justify-content:space-between;break-after:page}
.cover h1{font-size:34pt;line-height:1.1;letter-spacing:-.02em;margin:26mm 0 6mm;font-weight:700}
.cover .sub{font-size:15pt;color:#7A7A75;margin:0;max-width:150mm}
.cover .meta{font-size:10pt;color:#7A7A75;border-top:1px solid #ECECE8;padding-top:5mm;display:flex;justify-content:space-between}
.cover .brand{font-weight:700;color:#6510E0}
.toc{break-after:page}
.toc h2{font-size:18pt;margin:6mm 0 6mm}
.toc ol{list-style:none;margin:0;padding:0}
.toc li{display:flex;gap:4mm;align-items:baseline;padding:2.6mm 0;border-bottom:1px solid #ECECE8;font-size:11.5pt}
.toc .n{color:var(--c);font-weight:700;min-width:8mm}
section{margin:0 0 9mm}
section h2{font-size:16pt;line-height:1.25;margin:0 0 3mm;break-after:avoid;display:flex;gap:3mm;align-items:baseline}
section h2 .n{color:var(--c);font-size:12pt;font-weight:700}
section h2+*{break-before:avoid}
p{margin:0 0 3mm;orphans:3;widows:3}
ul{margin:1mm 0 3mm;padding:0;list-style:none}
li{position:relative;padding-left:5mm;margin:1.4mm 0;break-inside:avoid}
li::before{content:"";position:absolute;left:0;top:.62em;width:2mm;height:2mm;border-radius:50%;background:var(--c)}
table{width:100%;border-collapse:collapse;margin:2mm 0 4mm;font-size:10pt}
thead{display:table-header-group}
th{text-align:left;background:#141414;color:#fff;padding:2.4mm 3mm;font-weight:600}
td{padding:2.4mm 3mm;border-bottom:1px solid #ECECE8;vertical-align:top}
tr{break-inside:avoid}
tr:nth-child(even) td{background:#FAFAF8}
.hl{border-left:3px solid var(--c);background:#F6F3FE;border-radius:0 3mm 3mm 0;padding:3mm 4mm;margin:2mm 0 3mm;break-inside:avoid}
.hl p:last-child{margin:0}
`;

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
  return `<div style="width:100%;font-family:Inter,Arial,sans-serif;font-size:8px;color:#9A9A94;padding:0 18mm;display:flex;justify-content:space-between"><span>${esc(clip(title, 80))} · planejai</span><span><span class="pageNumber"></span> de <span class="totalPages"></span></span></div>`;
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
  const color = (i: number) => PALETTE[i % 6];
  const date = today.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });

  const cover = `<div class="cover"><div><div class="bar"></div><h1>${esc(clip(spec.title, 140))}</h1>${spec.subtitle ? `<p class="sub">${esc(clip(spec.subtitle, 260))}</p>` : ""}</div>
<div class="meta"><span>${spec.author ? `${esc(clip(spec.author, 80))} · ` : ""}${esc(date)}</span><span class="brand">planejai</span></div></div>`;
  // sumário só quando ajuda a navegar
  const toc =
    secs.length >= 4
      ? `<div class="toc"><div class="bar"></div><h2>Sumário</h2><ol>${secs.map((s, i) => `<li style="--c:${color(i)}"><span class="n">${i + 1}</span><span>${esc(s.title)}</span></li>`).join("")}</ol></div>`
      : "";
  const body = secs
    .map(
      (s, i) => `<section style="--c:${color(i)}"><h2><span class="n">${String(i + 1).padStart(2, "0")}</span><span>${esc(s.title)}</span></h2>
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
