import { htmlToPng } from "./charts.js";
import { DOC, FONT, mochi } from "./doc-theme.js";

/** cores dos ramos e cartões: família do roxo do Mochi, sem degradê */
const TONES = [DOC.violet, "#B832D6", "#4A3A8C", "#8B5CF6", DOC.night, "#A0459C", "#6D5BD0", "#77728A"];

/**
 * Imagens simples sob pedido (mapa mental, resumo em tópicos, passo a passo, tabela, frase), sem modelo de imagem:
 * a IA só manda o conteúdo em JSON, o desenho é HTML montado aqui e vira PNG no navegador da stack. Rápido e quase sem token.
 */

export type ImageKind = "mapa_mental" | "lista" | "passos" | "tabela" | "frase";

export interface ImageSpec {
  kind: ImageKind;
  title: string;
  subtitle?: string;
  sections?: { title: string; items?: string[]; text?: string }[];
  columns?: string[];
  rows?: string[][];
  text?: string;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const BASE_CSS = `
*{box-sizing:border-box}html,body{margin:0;background:${DOC.marsh}}
body{font-family:${FONT};color:${DOC.ink};-webkit-font-smoothing:antialiased}
.page{margin:0;background:${DOC.marsh};padding:60px 64px 48px;position:relative}
.brand{display:flex;align-items:center;gap:14px;color:${DOC.violet};font-size:20px;font-weight:600}
h1{font-size:44px;line-height:1.12;margin:26px 0 8px;font-weight:700;letter-spacing:-.02em}
.sub{font-size:23px;line-height:1.4;color:${DOC.muted};margin:0 0 40px}
.foot{display:flex;align-items:center;justify-content:flex-end;gap:10px;color:${DOC.muted};font-size:17px;margin-top:40px}
.foot b{color:${DOC.violet}}
ul{margin:0;padding:0;list-style:none}
li{position:relative;padding-left:20px;margin:9px 0;font-size:21px;line-height:1.4;color:${DOC.text}}
li::before{content:"";position:absolute;left:2px;top:.62em;width:7px;height:7px;border-radius:50%;background:var(--c,${DOC.violet})}
`;

function page(width: number, inner: string, css = "", script = "") {
  return {
    width,
    html: `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${css}</style></head><body><div class="page" style="width:${width}px">${inner}<div class="foot">${mochi(28, "ft")}<span>feito pelo <b>planejai</b></span></div></div>${script ? `<script>${script}</script>` : ""}</body></html>`,
  };
}

function header(s: ImageSpec, kicker = "") {
  return `<div class="brand">${mochi(40, "hd")}${kicker ? `<span>${esc(kicker)}</span>` : ""}</div><h1>${esc(clip(s.title, 90))}</h1>${s.subtitle ? `<p class="sub">${esc(clip(s.subtitle, 140))}</p>` : '<div style="height:32px"></div>'}`;
}

const sectionsOf = (s: ImageSpec) =>
  (s.sections ?? [])
    .filter((x) => x && x.title)
    .slice(0, 10)
    .map((x) => ({ title: clip(x.title, 60), text: x.text ? clip(x.text, 260) : "", items: (x.items ?? []).slice(0, 7).map((i) => clip(i, 120)) }));

function mindMap(s: ImageSpec) {
  const secs = sectionsOf(s);
  const half = Math.ceil(secs.length / 2);
  const card = (x: (typeof secs)[number], i: number) =>
    `<div class="br" data-i="${i}" style="--c:${TONES[i % TONES.length]}"><div class="bt"><i></i>${esc(x.title)}</div>${x.text ? `<p>${esc(x.text)}</p>` : ""}${x.items.length ? `<ul>${x.items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}</div>`;
  const left = secs.slice(0, half).map((x, i) => card(x, i)).join("");
  const right = secs.slice(half).map((x, i) => card(x, i + half)).join("");
  const css = `
.map{position:relative;display:grid;grid-template-columns:1fr 300px 1fr;gap:0 96px;align-items:center;margin-top:8px}
.col{display:flex;flex-direction:column;gap:22px;position:relative;z-index:1}
.center{z-index:1;background:${DOC.night};color:#fff;border-radius:32px;padding:34px 28px;text-align:center;font-size:31px;font-weight:700;line-height:1.2;letter-spacing:-.01em}
.center small{display:block;margin:0 auto 14px;width:max-content}
.br{background:#fff;border:1.5px solid ${DOC.line};border-radius:22px;padding:20px 24px 18px}
.bt{display:flex;align-items:center;gap:12px;color:var(--c);font-weight:700;font-size:24px;line-height:1.25;letter-spacing:-.01em}
.bt i{flex:none;width:14px;height:14px;border-radius:50%;background:var(--c)}
.br p{font-size:20px;line-height:1.4;margin:10px 0 0;color:${DOC.text}}
.br ul{margin-top:6px}
svg.lines{position:absolute;inset:0;width:100%;height:100%;z-index:0;overflow:visible}`;
  const script = `(function(){var m=document.querySelector('.map'),c=document.querySelector('.center');if(!m||!c)return;var R=m.getBoundingClientRect(),C=c.getBoundingClientRect(),p='';
document.querySelectorAll('.br').forEach(function(b){var B=b.getBoundingClientRect(),isL=B.right<C.left,x1=isL?C.left-R.left:C.right-R.left,y1=C.top+C.height/2-R.top,x2=isL?B.right-R.left:B.left-R.left,y2=B.top+B.height/2-R.top,mx=(x1+x2)/2,col=getComputedStyle(b).getPropertyValue('--c');
p+='<path d="M'+x1+' '+y1+' C'+mx+' '+y1+' '+mx+' '+y2+' '+x2+' '+y2+'" stroke="'+col+'" stroke-width="3" stroke-opacity=".55" fill="none" stroke-linecap="round"/><circle cx="'+x2+'" cy="'+y2+'" r="6" fill="'+col+'"/>';});
var s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.setAttribute('class','lines');s.innerHTML=p;m.prepend(s);})();`;
  const inner = `<div class="brand">${mochi(40, "hd")}<span>Mapa mental</span></div><h1>${esc(clip(s.title, 90))}</h1>${s.subtitle ? `<p class="sub">${esc(clip(s.subtitle, 140))}</p>` : '<div style="height:28px"></div>'}
<div class="map"><div class="col">${left}</div><div class="center"><small>${mochi(64, "ct")}</small>${esc(clip(s.title, 80))}</div><div class="col">${right}</div></div>`;
  return page(1600, inner, css, script);
}

function list(s: ImageSpec) {
  const secs = sectionsOf(s);
  const cols = secs.length > 3 ? 2 : 1;
  const css = `.grid{display:grid;grid-template-columns:repeat(${cols},1fr);gap:20px}
.card{background:#fff;border:1.5px solid ${DOC.line};border-radius:22px;padding:24px 26px}
.card h2{display:flex;align-items:center;gap:12px;margin:0 0 6px;font-size:26px;letter-spacing:-.01em;color:var(--c)}.card h2 i{flex:none;width:14px;height:14px;border-radius:50%;background:var(--c)}
.card p{font-size:21px;line-height:1.45;margin:8px 0 0;color:${DOC.text}}`;
  const body = secs
    .map((x, i) => `<div class="card" style="--c:${TONES[i % TONES.length]}"><h2><i></i>${esc(x.title)}</h2>${x.text ? `<p>${esc(x.text)}</p>` : ""}${x.items.length ? `<ul>${x.items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}</div>`)
    .join("");
  return page(1080, `${header(s, "Resumo")}<div class="grid">${body}</div>`, css);
}

function steps(s: ImageSpec) {
  const secs = sectionsOf(s);
  const css = `.st{display:grid;grid-template-columns:60px 1fr;gap:22px;position:relative;padding-bottom:28px}
.st:not(:last-child)::after{content:"";position:absolute;left:29px;top:68px;bottom:8px;width:2px;background:${DOC.line}}
.n{width:60px;height:60px;border-radius:50%;background:${DOC.night};color:#fff;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:700}
.st:first-child .n{background:${DOC.violet}}
.st h2{margin:12px 0 4px;font-size:26px;letter-spacing:-.01em}.st p{margin:4px 0;font-size:21px;line-height:1.45;color:${DOC.text}}`;
  const body = secs
    .map((x, i) => `<div class="st"><div class="n">${i + 1}</div><div><h2>${esc(x.title)}</h2>${x.text ? `<p>${esc(x.text)}</p>` : ""}${x.items.length ? `<ul>${x.items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}</div></div>`)
    .join("");
  return page(1080, `${header(s, "Passo a passo")}<div>${body}</div>`, css);
}

function table(s: ImageSpec) {
  const cols = (s.columns ?? []).slice(0, 6).map((c) => clip(c, 40));
  const rows = (s.rows ?? []).slice(0, 16).map((r) => cols.map((_, i) => clip(r?.[i], 80)));
  const css = `table{width:100%;border-collapse:separate;border-spacing:0;font-size:21px}
th{text-align:left;background:${DOC.night};color:#fff;padding:15px 18px;font-weight:600}th:first-child{border-radius:14px 0 0 0}th:last-child{border-radius:0 14px 0 0}
td{padding:15px 18px;border-bottom:1.5px solid ${DOC.line};line-height:1.4;background:#fff;color:${DOC.text}}tr:nth-child(even) td{background:${DOC.soft}}td:first-child{font-weight:600;color:${DOC.ink}}`;
  const body = `<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  return page(1080, `${header(s, "Tabela")}${body}`, css);
}

function quote(s: ImageSpec) {
  const css = `.q{font-size:44px;line-height:1.3;font-weight:700;letter-spacing:-.01em;margin:40px 0 20px}.q::before{content:"“";display:block;font-size:120px;line-height:.8;color:${DOC.violet}}
.who{font-size:24px;color:${DOC.muted}}`;
  return page(1080, `<div class="brand">${mochi(40, "hd")}</div><p class="q">${esc(clip(s.text || s.title, 400))}</p><p class="who">${esc(clip(s.subtitle ?? (s.text ? s.title : ""), 120))}</p>`, css);
}

export function buildImageHtml(spec: ImageSpec) {
  switch (spec.kind) {
    case "mapa_mental":
      return mindMap(spec);
    case "passos":
      return steps(spec);
    case "tabela":
      return table(spec);
    case "frase":
      return quote(spec);
    default:
      return list(spec);
  }
}

export async function renderImage(spec: ImageSpec) {
  const { html, width } = buildImageHtml(spec);
  return htmlToPng(html, width);
}
