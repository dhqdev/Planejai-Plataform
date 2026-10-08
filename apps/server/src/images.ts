import { PALETTE, htmlToPng } from "./charts.js";

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
*{box-sizing:border-box}html,body{margin:0;background:#F6F6F4}
body{font-family:Inter,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#141414;-webkit-font-smoothing:antialiased}
.page{margin:0;background:#fff;padding:56px;position:relative}
.bar{width:64px;height:8px;border-radius:4px;background:linear-gradient(90deg,#6510E0,#C42BEA)}
h1{font-size:40px;line-height:1.15;margin:22px 0 6px;font-weight:700;letter-spacing:-.01em}
.sub{font-size:24px;color:#7A7A75;margin:0 0 36px}
.foot{text-align:right;color:#B5B5AF;font-size:18px;margin-top:36px}
ul{margin:0;padding:0;list-style:none}
li{position:relative;padding-left:18px;margin:8px 0;font-size:21px;line-height:1.35}
li::before{content:"";position:absolute;left:0;top:.6em;width:7px;height:7px;border-radius:50%;background:var(--c,#141414)}
`;

function page(width: number, inner: string, css = "", script = "") {
  return {
    width,
    html: `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${css}</style></head><body><div class="page" style="width:${width}px">${inner}<div class="foot">planejai</div></div>${script ? `<script>${script}</script>` : ""}</body></html>`,
  };
}

function header(s: ImageSpec) {
  return `<div class="bar"></div><h1>${esc(clip(s.title, 90))}</h1>${s.subtitle ? `<p class="sub">${esc(clip(s.subtitle, 140))}</p>` : '<div style="height:28px"></div>'}`;
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
    `<div class="br" data-i="${i}" style="--c:${PALETTE[i % 8]}"><div class="bt">${esc(x.title)}</div>${x.text ? `<p>${esc(x.text)}</p>` : ""}${x.items.length ? `<ul>${x.items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}</div>`;
  const left = secs.slice(0, half).map((x, i) => card(x, i)).join("");
  const right = secs.slice(half).map((x, i) => card(x, i + half)).join("");
  const css = `
.map{position:relative;display:grid;grid-template-columns:1fr 300px 1fr;gap:0 90px;align-items:center}
.col{display:flex;flex-direction:column;gap:22px;position:relative;z-index:1}
.center{z-index:1;background:linear-gradient(135deg,#6510E0,#210552);color:#fff;border-radius:28px;padding:30px 26px;text-align:center;font-size:30px;font-weight:700;line-height:1.2;box-shadow:0 10px 30px rgba(101,16,224,.25)}
.br{background:#fff;border:2px solid #ECECE8;border-radius:20px;padding:18px 20px}
.bt{display:inline-block;background:var(--c);color:#fff;font-weight:700;font-size:22px;border-radius:12px;padding:6px 14px;margin-bottom:6px}
.br p{font-size:20px;line-height:1.35;margin:8px 0 0;color:#3A3A36}
svg.lines{position:absolute;inset:0;width:100%;height:100%;z-index:0;overflow:visible}`;
  const script = `(function(){var m=document.querySelector('.map'),c=document.querySelector('.center');if(!m||!c)return;var R=m.getBoundingClientRect(),C=c.getBoundingClientRect(),p='';
document.querySelectorAll('.br').forEach(function(b){var B=b.getBoundingClientRect(),isL=B.right<C.left,x1=isL?C.left-R.left:C.right-R.left,y1=C.top+C.height/2-R.top,x2=isL?B.right-R.left:B.left-R.left,y2=B.top+B.height/2-R.top,mx=(x1+x2)/2;
p+='<path d="M'+x1+' '+y1+' C'+mx+' '+y1+' '+mx+' '+y2+' '+x2+' '+y2+'" stroke="'+getComputedStyle(b).getPropertyValue('--c')+'" stroke-width="4" fill="none" stroke-linecap="round"/>';});
var s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.setAttribute('class','lines');s.innerHTML=p;m.prepend(s);})();`;
  const inner = `<div class="bar"></div><h1>Mapa mental</h1>${s.subtitle ? `<p class="sub">${esc(clip(s.subtitle, 140))}</p>` : '<div style="height:24px"></div>'}
<div class="map"><div class="col">${left}</div><div class="center">${esc(clip(s.title, 80))}</div><div class="col">${right}</div></div>`;
  return page(1600, inner, css, script);
}

function list(s: ImageSpec) {
  const secs = sectionsOf(s);
  const cols = secs.length > 3 ? 2 : 1;
  const css = `.grid{display:grid;grid-template-columns:repeat(${cols},1fr);gap:22px}
.card{border:2px solid #ECECE8;border-radius:20px;padding:22px 24px;border-top:8px solid var(--c)}
.card h2{margin:0 0 6px;font-size:26px}.card p{font-size:21px;line-height:1.4;margin:6px 0 0;color:#3A3A36}`;
  const body = secs
    .map((x, i) => `<div class="card" style="--c:${PALETTE[i % 8]}"><h2>${esc(x.title)}</h2>${x.text ? `<p>${esc(x.text)}</p>` : ""}${x.items.length ? `<ul>${x.items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}</div>`)
    .join("");
  return page(1080, `${header(s)}<div class="grid">${body}</div>`, css);
}

function steps(s: ImageSpec) {
  const secs = sectionsOf(s);
  const css = `.st{display:grid;grid-template-columns:64px 1fr;gap:20px;position:relative;padding-bottom:26px}
.st:not(:last-child)::after{content:"";position:absolute;left:31px;top:64px;bottom:0;width:3px;background:#ECECE8}
.n{width:64px;height:64px;border-radius:50%;background:var(--c);color:#fff;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700}
.st h2{margin:12px 0 4px;font-size:26px}.st p{margin:4px 0;font-size:21px;line-height:1.4;color:#3A3A36}`;
  const body = secs
    .map((x, i) => `<div class="st" style="--c:${PALETTE[i % 8]}"><div class="n">${i + 1}</div><div><h2>${esc(x.title)}</h2>${x.text ? `<p>${esc(x.text)}</p>` : ""}${x.items.length ? `<ul>${x.items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}</div></div>`)
    .join("");
  return page(1080, `${header(s)}<div>${body}</div>`, css);
}

function table(s: ImageSpec) {
  const cols = (s.columns ?? []).slice(0, 6).map((c) => clip(c, 40));
  const rows = (s.rows ?? []).slice(0, 16).map((r) => cols.map((_, i) => clip(r?.[i], 80)));
  const css = `table{width:100%;border-collapse:separate;border-spacing:0;font-size:21px}
th{text-align:left;background:#141414;color:#fff;padding:14px 16px;font-weight:600}th:first-child{border-radius:14px 0 0 0}th:last-child{border-radius:0 14px 0 0}
td{padding:14px 16px;border-bottom:2px solid #ECECE8;line-height:1.35}tr:nth-child(even) td{background:#FAFAF8}td:first-child{font-weight:600}`;
  const body = `<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  return page(1080, `${header(s)}${body}`, css);
}

function quote(s: ImageSpec) {
  const css = `.q{font-size:44px;line-height:1.3;font-weight:700;letter-spacing:-.01em;margin:40px 0 20px}.q::before{content:"“";display:block;font-size:120px;line-height:.8;background:linear-gradient(90deg,#6510E0,#C42BEA);-webkit-background-clip:text;color:transparent}
.who{font-size:24px;color:#7A7A75}`;
  return page(1080, `<div class="bar"></div><p class="q">${esc(clip(s.text || s.title, 400))}</p><p class="who">${esc(clip(s.subtitle ?? (s.text ? s.title : ""), 120))}</p>`, css);
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
