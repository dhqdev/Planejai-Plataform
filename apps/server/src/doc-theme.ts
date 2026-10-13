/**
 * Visual único dos documentos que o Planejai gera (make_pdf, relatório de Finanças, make_image e gráficos):
 * cores da "noite do Mascote" do painel, sem degradê, um roxo só de destaque, o Mascote na capa e no rodapé.
 * Tudo HTML/CSS montado aqui, sem IA.
 */

export const DOC = {
  night: "#1D0B42",
  marsh: "#FBF8FF",
  violet: "#6510E0",
  /** roxo claro para texto sobre a capa escura */
  lilac: "#C9B6F5",
  ink: "#1A1530",
  text: "#3B3650",
  muted: "#77728A",
  line: "#ECE8F4",
  soft: "#F4F0FC",
  pos: "#1F7A4D",
  neg: "#C62F45",
} as const;

export const FONT = `Inter,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif`;

/** O Mascote do logo do painel (apps/dashboard/public/logo.svg). `id` evita colisão quando aparece mais de uma vez. */
export function mascote(size: number, id = "mo") {
  const body = "M60 42 C88 42 102 45.5 102 64 L102 82 C102 100 88 106 60 106 C32 106 18 100 18 82 L18 64 C18 45.5 32 42 60 42 Z";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="12 34 96 80" width="${size}" height="${Math.round((size * 80) / 96)}" style="display:block">
<defs><radialGradient id="${id}b" cx="0.6" cy="0.2" r="0.95" fx="0.62" fy="0.18"><stop offset="0" stop-color="#fff"/><stop offset="0.35" stop-color="#f3f3f5"/><stop offset="0.7" stop-color="#dcdce0"/><stop offset="1" stop-color="#b9b9bf"/></radialGradient></defs>
<path d="${body}" fill="url(#${id}b)"/><path d="${body}" fill="none" stroke="#000" stroke-opacity="0.08" stroke-width="0.8"/>
<ellipse cx="43" cy="78" rx="6.2" ry="7.2" fill="#121214"/><ellipse cx="77" cy="78" rx="6.2" ry="7.2" fill="#121214"/>
<ellipse cx="45" cy="75.2" rx="1.7" ry="1.4" fill="#fff" opacity="0.92"/><ellipse cx="79" cy="75.2" rx="1.7" ry="1.4" fill="#fff" opacity="0.92"/></svg>`;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * CSS comum dos PDFs A4: capa escura de página inteira (a primeira página não tem margem nem rodapé),
 * títulos de seção com número discreto, tabelas com cabeçalho noite, destaque em lilás claro.
 */
export const PDF_BASE_CSS = `
@page{size:A4;margin:20mm 17mm 20mm}
@page:first{margin:0}
*{box-sizing:border-box}
html,body{margin:0;background:#fff}
body{font-family:${FONT};color:${DOC.ink};font-size:10.5pt;line-height:1.6;-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.cover{width:210mm;height:296.5mm;background:${DOC.night};color:#fff;padding:22mm 20mm 20mm;display:flex;flex-direction:column;break-after:page;overflow:hidden}
.cv-top{display:flex;align-items:center;gap:3.5mm}
.cv-top span{font-weight:700;font-size:13pt;letter-spacing:-.01em}
.cv-main{margin-top:auto}
.cv-kicker{color:${DOC.lilac};font-size:11pt;margin:0 0 5mm}
.cover h1{font-size:36pt;line-height:1.08;letter-spacing:-.025em;margin:0;font-weight:700;max-width:165mm}
.cv-sub{font-size:13.5pt;line-height:1.45;color:rgba(255,255,255,.72);margin:6mm 0 0;max-width:150mm}
.cv-extra{margin-top:12mm}
.cv-meta{margin-top:16mm;padding-top:5mm;border-top:1px solid rgba(255,255,255,.16);display:flex;justify-content:space-between;font-size:9.5pt;color:rgba(255,255,255,.6)}
.toc{break-after:page}
.toc h2,.sec-h{font-size:17pt;line-height:1.2;letter-spacing:-.015em;margin:0 0 6mm;font-weight:700}
.toc ol{list-style:none;margin:0;padding:0}
.toc li{display:flex;gap:5mm;align-items:baseline;padding:3mm 0;border-bottom:1px solid ${DOC.line};font-size:11pt}
.toc li::before{display:none}
.toc .n{color:${DOC.violet};font-weight:600;min-width:7mm;font-variant-numeric:tabular-nums}
section{margin:0 0 10mm}
section>h2{font-size:15.5pt;line-height:1.25;letter-spacing:-.01em;margin:0 0 4mm;padding-bottom:2.5mm;border-bottom:1px solid ${DOC.line};break-after:avoid;display:flex;gap:3.5mm;align-items:baseline}
section>h2 .n{color:${DOC.violet};font-size:10.5pt;font-weight:600;font-variant-numeric:tabular-nums}
section>h2+*{break-before:avoid}
h3{font-size:11.5pt;margin:6mm 0 2.5mm;break-after:avoid}
p{margin:0 0 3mm;orphans:3;widows:3;color:${DOC.text}}
p b,p strong,li strong{color:${DOC.ink}}
ul{margin:1mm 0 3.5mm;padding:0;list-style:none}
li{position:relative;padding-left:5.5mm;margin:1.6mm 0;break-inside:avoid;color:${DOC.text}}
li::before{content:"";position:absolute;left:.5mm;top:.68em;width:1.8mm;height:1.8mm;border-radius:50%;background:${DOC.violet}}
table{width:100%;border-collapse:collapse;margin:2mm 0 5mm;font-size:9.5pt}
thead{display:table-header-group}
th{text-align:left;background:${DOC.night};color:#fff;padding:2.4mm 3mm;font-weight:600}
td{padding:2.3mm 3mm;border-bottom:1px solid ${DOC.line};vertical-align:top;color:${DOC.text}}
td.r,th.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr{break-inside:avoid}
tbody tr:nth-child(even) td{background:${DOC.marsh}}
.hl{background:${DOC.soft};border-radius:3mm;padding:3.5mm 4.5mm;margin:3mm 0 4mm;break-inside:avoid}
.hl p{color:${DOC.ink}}
.hl p:last-child{margin:0}
.muted{color:${DOC.muted}}
`;

/** Capa escura de página inteira. `extra` entra logo abaixo do subtítulo (números do relatório, por exemplo). */
export function coverHtml(o: { kicker: string; title: string; subtitle?: string; extra?: string; metaLeft: string; metaRight: string }) {
  return `<div class="cover"><div class="cv-top">${mascote(40, "cv")}<span>planejai</span></div>
<div class="cv-main"><p class="cv-kicker">${esc(o.kicker)}</p><h1>${o.title}</h1>${o.subtitle ? `<p class="cv-sub">${o.subtitle}</p>` : ""}${o.extra ? `<div class="cv-extra">${o.extra}</div>` : ""}</div>
<div class="cv-meta"><span>${o.metaLeft}</span><span>${o.metaRight}</span></div></div>`;
}

/** Rodapé de cada página (o navegador numera; a capa não tem). */
export function docFooter(title: string) {
  return `<div style="width:100%;font-family:Inter,Arial,sans-serif;font-size:7.5px;color:${DOC.muted};padding:0 17mm;display:flex;justify-content:space-between;align-items:center"><span><b style="color:${DOC.violet};font-weight:700">planejai</b> · ${esc(title)}</span><span><span class="pageNumber"></span> de <span class="totalPages"></span></span></div>`;
}
