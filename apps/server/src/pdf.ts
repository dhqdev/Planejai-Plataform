import { htmlToPdf } from "./charts.js";
import { DOC, PDF_BASE_CSS, coverHtml, docFooter, mascote } from "./doc-theme.js";

/**
 * PDF de várias páginas sob pedido (relatório, apostila, roteiro, plano), no mesmo esquema do make_image:
 * a IA só manda o conteúdo, o layout (capa com foto, sumário, seções com foto, números em cartões, gráfico
 * de barras, tabelas, dica e atenção) é HTML montado aqui e vira PDF A4 no navegador da stack. As fotos
 * chegam já baixadas (data URL, ver agent/tools/pdf.ts); sem elas o documento sai igual, só sem foto.
 */

export interface PdfSection {
  title: string;
  /** parágrafos separados por linha em branco */
  text?: string;
  items?: string[];
  table?: { columns: string[]; rows: string[][] };
  /** caixa de destaque no fim da seção (dica, resumo) */
  highlight?: string;
  /** caixa de atenção (cuidado, risco) */
  warning?: string;
  /** busca da foto real que ilustra a seção (a ferramenta baixa e embute) */
  image?: string;
  /** números importantes em cartões: "120" + "pessoas atendidas" */
  stats?: { value: string; label: string }[];
  /** gráfico de barras simples, montado em HTML */
  chart?: { title?: string; bars: { label: string; value: number; text?: string }[] };
}

export interface PdfSpec {
  title: string;
  subtitle?: string;
  author?: string;
  /** busca da foto da capa */
  coverImage?: string;
  /** linha acima do título na capa (padrão "Documento · N partes") */
  kicker?: string;
  /** false tira o sumário (documento curto que se lê de uma vez, como a ata de reunião) */
  toc?: boolean;
  sections: PdfSection[];
}

/** Foto já baixada, embutida no HTML (data URL), com o site de onde veio. */
export interface PdfImg {
  src: string;
  credit?: string;
}
export interface PdfImages {
  cover?: PdfImg;
  /** pela posição da seção */
  sections: Record<number, PdfImg>;
}

export const PDF_LIMITS = { sections: 40, text: 6000, items: 30, cols: 6, rows: 60, images: 4, stats: 4, bars: 12 } as const;

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

/** Só imagem embutida passa (nada de URL externa no HTML que o navegador da stack abre). */
const safeSrc = (img?: PdfImg) => (img && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(img.src) ? img : undefined);

const CSS = `${PDF_BASE_CSS}
.cover.photo{padding:0}
.cv-photo{height:150mm;background-size:cover;background-position:center;position:relative}
.cv-photo .cv-top{position:absolute;left:20mm;top:16mm;background:${DOC.night};padding:2.5mm 4.5mm 2.5mm 3mm;border-radius:99px}
.cv-photo .cv-top span{font-size:11pt}
.cover.photo .cv-body{flex:1;display:flex;flex-direction:column;padding:14mm 20mm 20mm}
.cover.photo .cv-main{margin-top:0}
.cover.photo h1{font-size:32pt}
.cv-credit{position:absolute;right:6mm;bottom:3mm;font-size:7pt;color:rgba(255,255,255,.85);background:rgba(0,0,0,.35);padding:.6mm 2mm;border-radius:99px}
.cover{position:relative}
.cv-art{position:absolute;right:22mm;top:58mm;opacity:.97}
.cv-parts{display:flex;flex-wrap:wrap;gap:2mm;margin-top:9mm;max-width:170mm}
.cv-parts span{font-size:9pt;color:rgba(255,255,255,.78);border:1px solid rgba(255,255,255,.2);border-radius:99px;padding:1.2mm 3.5mm}
section>h2 .n{display:inline-grid;place-items:center;min-width:8mm;height:8mm;padding:0 1.5mm;border-radius:2.2mm;background:${DOC.soft};color:${DOC.violet};font-size:9.5pt;align-self:center}
section>h2{align-items:center}
figure{margin:1mm 0 5mm;break-inside:avoid}
figure .ph{height:72mm;border-radius:3mm;background-size:cover;background-position:center;background-color:${DOC.soft}}
figcaption{font-size:7.5pt;color:${DOC.muted};margin-top:1.5mm;text-align:right}
.stats{display:grid;gap:3mm;margin:2mm 0 5mm;break-inside:avoid}
.stats.c2{grid-template-columns:repeat(2,1fr)}.stats.c3{grid-template-columns:repeat(3,1fr)}.stats.c4{grid-template-columns:repeat(4,1fr)}.stats.c1{grid-template-columns:1fr}
.stat{border:1px solid ${DOC.line};border-radius:3mm;padding:3.5mm 4mm}
.stat b{display:block;font-size:17pt;line-height:1.15;letter-spacing:-.02em;color:${DOC.violet};font-variant-numeric:tabular-nums}
.stat span{display:block;font-size:8.5pt;line-height:1.35;color:${DOC.muted};margin-top:1mm}
.chart{border:1px solid ${DOC.line};border-radius:3mm;padding:4mm 4.5mm 3mm;margin:2mm 0 5mm;break-inside:avoid}
.chart h4{margin:0 0 3mm;font-size:10pt;font-weight:600;color:${DOC.ink}}
.bar{display:grid;grid-template-columns:40mm 1fr 24mm;gap:3mm;align-items:center;margin:0 0 2.2mm;font-size:9pt}
.bar .l{color:${DOC.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar .t{height:4.2mm;background:${DOC.soft};border-radius:99px;overflow:hidden}
.bar .t i{display:block;height:100%;background:${DOC.violet};border-radius:99px;min-width:1.5mm}
.bar .v{text-align:right;font-variant-numeric:tabular-nums;color:${DOC.ink};font-weight:600;white-space:nowrap}
.hl,.warn{position:relative;padding-top:3mm}
.hl .tag,.warn .tag{display:block;font-size:8pt;font-weight:700;letter-spacing:.02em;margin:0 0 1mm}
.hl .tag{color:${DOC.violet}}
.warn{background:#FFF6E8;border-radius:3mm;padding:3mm 4.5mm 3.5mm;margin:3mm 0 4mm;break-inside:avoid}
.warn .tag{color:#9A5B00}
.warn p{color:${DOC.ink}}
.warn p:last-child{margin:0}
ul.cols{columns:2;column-gap:8mm}
ul.cols li{break-inside:avoid}
.end{margin-top:12mm;padding-top:6mm;border-top:1px solid ${DOC.line};display:flex;align-items:center;gap:4mm;color:${DOC.muted};font-size:9pt;break-inside:avoid}
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

/** Número de "R$ 1.234,50", "45%", "3.5" (o primeiro número do texto); null se não tem. */
export function chartNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = /-?\d[\d.,]*/.exec(String(v ?? ""));
  if (!m) return null;
  let t = m[0].replace(/[.,]$/, "");
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Campos extras da seção (foto, atenção, números, gráfico), com nomes variados no JSON. Só entram os que existem. */
function extras(o: Record<string, unknown>): Partial<PdfSection> {
  const out: Partial<PdfSection> = {};
  const warning = str(o.warning ?? o.atencao ?? o.alerta);
  if (warning) out.warning = warning;
  const image = str(o.image ?? o.imagem ?? o.foto);
  if (image) out.image = image;
  const stats = parseMaybe(o.stats ?? o.numeros ?? o.numbers);
  if (Array.isArray(stats)) {
    const list = stats
      .map((x) => {
        const r = (x ?? {}) as Record<string, unknown>;
        return { value: str(r.value ?? r.valor), label: str(r.label ?? r.rotulo) };
      })
      .filter((x) => x.value);
    if (list.length) out.stats = list;
  }
  const chart = parseMaybe(o.chart ?? o.grafico) as { title?: unknown; bars?: unknown } | undefined;
  if (chart && typeof chart === "object" && Array.isArray(chart.bars)) {
    const bars: NonNullable<PdfSection["chart"]>["bars"] = [];
    for (const b of chart.bars) {
      const r = (b ?? {}) as Record<string, unknown>;
      const value = chartNumber(r.value ?? r.valor);
      const label = str(r.label ?? r.rotulo);
      if (label && value != null) bars.push({ label, value, text: str(r.text ?? r.texto) || undefined });
    }
    if (bars.length) out.chart = { title: str(chart.title) || undefined, bars };
  }
  return out;
}

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
      ...extras(o),
    };
  });
  // sem seções mas com texto solto: vira uma seção só
  if (!sections.length && str(a.text ?? a.content)) sections.push({ title: str(a.title) || "Documento", text: str(a.text ?? a.content) });
  const coverImage = str(a.coverImage ?? a.cover_image ?? a.capa);
  return {
    title: str(a.title ?? a.titulo) || "Documento",
    subtitle: str(a.subtitle ?? a.subtitulo) || undefined,
    author: str(a.author) || undefined,
    ...(coverImage ? { coverImage } : {}),
    sections,
  };
}

/** Rodapé de cada página (o navegador numera): título à esquerda, "página X de Y" à direita. */
export function pdfFooter(title: string) {
  return docFooter(clip(title, 80));
}

const statsHtml = (stats: { value: string; label: string }[]) =>
  stats.length ? `<div class="stats c${stats.length}">${stats.map((s) => `<div class="stat"><b>${esc(s.value)}</b>${s.label ? `<span>${esc(s.label)}</span>` : ""}</div>`).join("")}</div>` : "";

function chartHtml(chart?: PdfSection["chart"]) {
  const bars = (chart?.bars ?? []).filter((b) => Number.isFinite(b.value)).slice(0, PDF_LIMITS.bars);
  if (!bars.length) return "";
  const max = Math.max(...bars.map((b) => Math.abs(b.value))) || 1;
  const fmt = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  return `<div class="chart">${chart?.title ? `<h4>${esc(clip(chart.title, 120))}</h4>` : ""}${bars
    .map((b) => `<div class="bar"><span class="l">${esc(clip(b.label, 60))}</span><span class="t"><i style="width:${Math.round((Math.abs(b.value) / max) * 1000) / 10}%"></i></span><span class="v">${esc(clip(b.text || fmt(b.value), 24))}</span></div>`)
    .join("")}</div>`;
}

const figureHtml = (img?: PdfImg) =>
  img ? `<figure><div class="ph" style="background-image:url('${img.src}')"></div>${img.credit ? `<figcaption>Foto: ${esc(clip(img.credit, 60))}</figcaption>` : ""}</figure>` : "";

export function buildPdfHtml(spec: PdfSpec, today = new Date(), images: PdfImages = { sections: {} }) {
  const L = PDF_LIMITS;
  const secs = (spec.sections ?? [])
    // modelo às vezes chama o título da seção de heading
    .map((s) => (s && !s.title && (s as { heading?: string }).heading ? { ...s, title: (s as { heading?: string }).heading! } : s))
    .filter((s) => s && s.title)
    .slice(0, L.sections)
    .map((s, i) => {
      const cols = (s.table?.columns ?? []).slice(0, L.cols).map((c) => clip(c, 60));
      const items = (s.items ?? []).slice(0, L.items).map((t) => clip(t, 400));
      return {
        title: clip(s.title, 120),
        text: s.text ? clip(s.text, L.text) : "",
        items,
        // lista longa de itens curtos vai em duas colunas
        twoCols: items.length >= 6 && items.every((t) => t.length <= 60),
        cols,
        rows: cols.length ? (s.table?.rows ?? []).slice(0, L.rows).map((r) => cols.map((_, j) => clip(r?.[j], 300))) : [],
        highlight: s.highlight ? clip(s.highlight, 800) : "",
        warning: s.warning ? clip(s.warning, 800) : "",
        stats: (s.stats ?? []).slice(0, L.stats).map((x) => ({ value: clip(x.value, 18), label: clip(x.label, 70) })),
        chart: s.chart,
        img: safeSrc(images.sections[i]),
      };
    });
  const date = today.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
  const n = (i: number) => String(i + 1).padStart(2, "0");
  const coverImg = safeSrc(images.cover);
  const title = esc(clip(spec.title, 140));
  const subtitle = spec.subtitle ? esc(clip(spec.subtitle, 260)) : undefined;
  const metaLeft = spec.author ? `Feito para ${esc(clip(spec.author, 80))}` : "Feito pelo seu assistente";
  const kicker = spec.kicker ? clip(spec.kicker, 60) : secs.length > 1 ? `Documento · ${secs.length} partes` : "Documento";
  // os assuntos do documento em pílulas na capa (até 6), para a capa já dizer o que tem dentro
  const parts = secs.length > 1 ? `<div class="cv-parts">${secs.slice(0, 6).map((s) => `<span>${esc(clip(s.title, 40))}</span>`).join("")}</div>` : "";

  const cover = coverImg
    ? `<div class="cover photo"><div class="cv-photo" style="background-image:url('${coverImg.src}')"><div class="cv-top">${mascote(30, "cv")}<span>planejai</span></div>${coverImg.credit ? `<span class="cv-credit">Foto: ${esc(clip(coverImg.credit, 60))}</span>` : ""}</div>
<div class="cv-body"><div class="cv-main"><p class="cv-kicker">${esc(kicker)}</p><h1>${title}</h1>${subtitle ? `<p class="cv-sub">${subtitle}</p>` : ""}${parts}</div>
<div class="cv-meta"><span>${metaLeft}</span><span>${esc(date)}</span></div></div></div>`
    : coverHtml({ kicker, title, subtitle, extra: `${parts}<div class="cv-art">${mascote(300, "art")}</div>`, metaLeft, metaRight: esc(date) });
  // sumário só quando ajuda a navegar
  const toc =
    spec.toc !== false && secs.length >= 4
      ? `<div class="toc"><h2>Sumário</h2><ol>${secs.map((s, i) => `<li><span class="n">${n(i)}</span><span>${esc(s.title)}</span></li>`).join("")}</ol></div>`
      : "";
  const body = secs
    .map(
      (s, i) => `<section><h2><span class="n">${n(i)}</span><span>${esc(s.title)}</span></h2>
${figureHtml(s.img)}${statsHtml(s.stats)}${paragraphs(s.text)}${s.items.length ? `<ul${s.twoCols ? ' class="cols"' : ""}>${s.items.map((t) => `<li>${inline(t)}</li>`).join("")}</ul>` : ""}${chartHtml(s.chart)}${
        s.cols.length && s.rows.length
          ? `<table><thead><tr>${s.cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${s.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
          : ""
      }${s.highlight ? `<div class="hl"><span class="tag">Dica</span>${paragraphs(s.highlight)}</div>` : ""}${s.warning ? `<div class="warn"><span class="tag">Atenção</span>${paragraphs(s.warning)}</div>` : ""}</section>`,
    )
    .join("");
  const end = `<div class="end">${mascote(28, "end")}<span>Feito pelo seu assistente Planejai em ${esc(date)}. Quer mudar algo? É só pedir no WhatsApp.</span></div>`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style></head><body>${cover}${toc}${body}${end}</body></html>`;
}

/** Nome de arquivo limpo a partir do título: "Plano de estudos 2026.pdf". */
export function pdfFileName(title: string) {
  const base = clip(title, 70).replace(/…$/, "").replace(/[\\/:*?"<>|\n\r\t]+/g, " ").replace(/\s+/g, " ").trim();
  return `${base || "documento"}.pdf`;
}

/** Com fotos se der; se o navegador recusar (HTML grande demais, foto quebrada), sai de novo sem elas. */
export async function renderPdf(spec: PdfSpec, images?: PdfImages): Promise<Buffer> {
  const footer = pdfFooter(spec.title);
  const hasImages = Boolean(images && (images.cover || Object.keys(images.sections).length));
  if (!hasImages) return htmlToPdf(buildPdfHtml(spec), footer);
  try {
    return await htmlToPdf(buildPdfHtml(spec, new Date(), images), footer);
  } catch {
    return htmlToPdf(buildPdfHtml(spec), footer);
  }
}
