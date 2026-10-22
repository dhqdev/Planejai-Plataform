/**
 * Lente de vidro líquido nas peças que flutuam sobre o conteúdo que rola no celular (barra de baixo, caixa e
 * botões do chat do Início). Pedido do David, 2026-10-22, a partir de github.com/ybouane/liquidglass.
 *
 * Daquela biblioteca vem a ótica: a borda em meia-lua (pílula biconvexa), a refração que puxa o fundo para dentro
 * na borda, a aberração cromática, o brilho de duas luzes, o Fresnel e o fio de luz por dentro. A biblioteca em si
 * não serve aqui: ela fotografa o HTML num canvas (html-to-image) e roda WebGL por cima; com a tela rolando teria
 * de fotografar a cada quadro, e cada foto levou de 2 a 4 s num celular simulado.
 *
 * Então a conta da lente roda uma vez por tamanho, aqui, e vira duas imagens:
 * - o mapa de deslocamento, usado num filtro SVG no backdrop-filter (o navegador refrata o que passa atrás, na GPU,
 *   rolando a 60 fps). Só Chrome/Android aceita filtro SVG no backdrop-filter; iPhone, Firefox e celular fraco ficam
 *   com o vidro de CSS de sempre (styles/vidro.css).
 * - a luz (brilho, Fresnel e fio da borda), uma imagem por cima da peça, que vale em todo navegador.
 * Menos transparência ou mais contraste no sistema: nada disso liga.
 */

type Lens = { url: string | null; light: string };
const SVG_NS = "http://www.w3.org/2000/svg";
const cache = new Map<string, Lens>();
let defs: SVGDefsElement | null = null;
let seq = 0;

const off = () => matchMedia("(prefers-reduced-transparency: reduce), (prefers-contrast: more)").matches;

/** Filtro SVG no backdrop-filter: Chrome e derivados fora do iPhone (lá todo navegador é Safari por dentro). */
export const canRefract = (() => {
  let memo: boolean | null = null;
  return () => {
    if (memo !== null) return memo;
    const ua = navigator.userAgent;
    const chromium = /Chrome\/\d+/.test(ua) && !/iPhone|iPad|iPod/.test(ua) && !/Firefox\//.test(ua);
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    // celular com pouca memória: o desfoque comum já pesa, a lente fica de fora
    memo = chromium && !(mem !== undefined && mem < 3) && typeof CSS !== "undefined" && CSS.supports("backdrop-filter", "blur(1px)");
    return memo;
  };
})();

// ---------- a ótica (FS_GLASS do liquidglass, em px de CSS, y para baixo) ----------
const rrSDF = (x: number, y: number, bx: number, by: number, r: number) => {
  const qx = Math.abs(x) - bx + r;
  const qy = Math.abs(y) - by + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
};
const bevel = (d: number, zR: number) => (d <= 0 ? 0 : d >= zR ? zR : Math.sqrt(d * (2 * zR - d)));
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const norm3 = (x: number, y: number, z: number) => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l] as const;
};
/** Meio do caminho entre a luz e o olho (Blinn-Phong). Luz forte em cima à esquerda, reflexo embaixo à direita,
 *  como a borda espelhada do vidro de CSS (--lg-rim). */
const half = (x: number, y: number, z: number) => {
  const [a, b, c] = norm3(x, y, z);
  return norm3(a, b, c + 1);
};
const H1 = half(-0.4, 0.7, 1);
const H2 = half(0.3, -0.5, 1);
const H4 = half(0, 0.9, 0.4);

/** Calcula as duas imagens de uma peça w×h com raio r. */
function build(w: number, h: number, r: number, dark: boolean): Lens {
  const hx = w / 2;
  const hy = h / 2;
  const rad = Math.min(r, hx, hy);
  // borda funda em peça grande, rasa em peça pequena (no liquidglass o padrão é 40 para painéis grandes)
  const zR = Math.max(6, Math.min(18, Math.min(hx, hy) * 0.5));
  const refract = 0.55;
  const refrPow = 1 - 1 / 1.5;
  const maxD = Math.min(hx, hy);
  const field = (px: number, py: number) => -rrSDF(px, py, hx, hy, rad);
  const at = (px: number, py: number) => {
    const inside = field(px, py);
    const e = 2;
    const gx = (bevel(field(px + e, py), zR) - bevel(field(px - e, py), zR)) / (2 * e);
    const gy = (bevel(field(px, py + e), zR) - bevel(field(px, py - e), zR)) / (2 * e);
    return { inside, gx, gy, hC: bevel(inside, zR) };
  };

  // mapa de deslocamento: 1 px de CSS por pixel basta (o fundo é desfocado depois)
  let url: string | null = null;
  if (canRefract()) {
    const mw = Math.round(w);
    const mh = Math.round(h);
    const dx = new Float32Array(mw * mh);
    const dy = new Float32Array(mw * mh);
    let peak = 1;
    for (let j = 0; j < mh; j++) {
      for (let i = 0; i < mw; i++) {
        const px = i + 0.5 - hx;
        const py = j + 0.5 - hy;
        const { inside, gx, gy, hC } = at(px, py);
        if (inside <= 0) continue;
        const thick = (hC * 2) / (zR * 2);
        const k = (2 * refrPow + refrPow * thick * 0.5) * refract * 30;
        const depth = smooth(0, zR, inside);
        // puxa para dentro na borda (o fundo some "dobrando" na curva) e um nada para o centro no miolo
        const x = gx * k - (px / hx) * refract * 4 * depth;
        const y = gy * k - (py / hy) * refract * 4 * depth;
        dx[j * mw + i] = x;
        dy[j * mw + i] = y;
        peak = Math.max(peak, Math.abs(x), Math.abs(y));
      }
    }
    // no máximo 1/3 da altura: além disso a borda vira espelho do miolo
    const cap = Math.min(peak, h / 3);
    const cv = document.createElement("canvas");
    cv.width = mw;
    cv.height = mh;
    const g = cv.getContext("2d");
    if (g) {
      const img = g.createImageData(mw, mh);
      for (let n = 0; n < mw * mh; n++) {
        img.data[n * 4] = Math.round(127.5 + (Math.max(-cap, Math.min(cap, dx[n]!)) / cap) * 127.5);
        img.data[n * 4 + 1] = Math.round(127.5 + (Math.max(-cap, Math.min(cap, dy[n]!)) / cap) * 127.5);
        img.data[n * 4 + 2] = 128;
        img.data[n * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      url = filterFor(cv.toDataURL("image/png"), cap * 2);
    }
  }

  // a luz: brilho de duas luzes, Fresnel e o fio por dentro da borda, mais forte em cima
  const s = Math.min(2, devicePixelRatio || 1);
  const lw = Math.round(w * s);
  const lh = Math.round(h * s);
  const cv = document.createElement("canvas");
  cv.width = lw;
  cv.height = lh;
  const g = cv.getContext("2d");
  let light = "none";
  if (g) {
    const img = g.createImageData(lw, lh);
    const gain = dark ? 0.55 : 1;
    for (let j = 0; j < lh; j++) {
      for (let i = 0; i < lw; i++) {
        const px = (i + 0.5) / s - hx;
        const py = (j + 0.5) / s - hy;
        const { inside, gx, gy } = at(px, py);
        if (inside <= 0) continue;
        // normal da superfície (y para cima nas luzes, como no shader)
        const [nx, ny, nz] = norm3(-gx, gy, 1);
        const dot = (v: readonly [number, number, number]) => Math.max(0, nx * v[0] + ny * v[1] + nz * v[2]);
        const spec = (dot(H1) ** 90 + dot(H2) ** 50 * 0.3 + dot(H4) ** 120 * 0.6) * 0.5;
        const fres = (1 - Math.abs(nz)) ** 4 * 0.2;
        const edge = smooth(maxD * 0.35, 0, inside);
        const stroke = smooth(0, 1, inside) * (1 - smooth(1.5, 2.5, inside)) * (0.4 + 0.6 * (0.5 - 0.5 * (py / hy)));
        const a = Math.min(1, (spec + fres + edge * 0.05 + stroke * 0.55) * gain);
        const n = (j * lw + i) * 4;
        img.data[n] = 255;
        img.data[n + 1] = 255;
        img.data[n + 2] = 255;
        img.data[n + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
    light = `url("${cv.toDataURL("image/png")}")`;
  }
  return { url, light };
}

/** Filtro: desloca o fundo pelo mapa, um pouco mais no vermelho e menos no azul (aberração cromática). */
function filterFor(map: string, scale: number): string {
  if (!defs) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.style.position = "absolute";
    defs = document.createElementNS(SVG_NS, "defs");
    svg.appendChild(defs);
    document.body.appendChild(svg);
  }
  const id = `pj-lg-${++seq}`;
  const f = document.createElementNS(SVG_NS, "filter");
  f.id = id;
  // região e mapa na caixa da peça (objectBoundingBox): enquanto a barra encolhe ou cresce, o mapa estica junto
  // até o novo ser calculado; o deslocamento (scale) continua em px
  f.setAttribute("x", "0");
  f.setAttribute("y", "0");
  f.setAttribute("width", "1");
  f.setAttribute("height", "1");
  f.setAttribute("color-interpolation-filters", "sRGB");
  const chan = (c: 0 | 1 | 2) => ["1 0 0 0 0", "0 1 0 0 0", "0 0 1 0 0"].map((row, k) => (k === c ? row : "0 0 0 0 0")).join(" ") + " 0 0 0 1 0";
  const pass = (c: 0 | 1 | 2, k: number) =>
    `<feDisplacementMap in="SourceGraphic" in2="m" scale="${(scale * k).toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="d${c}"/>` +
    `<feColorMatrix in="d${c}" type="matrix" values="${chan(c)}" result="c${c}"/>`;
  f.innerHTML =
    `<feImage href="${map}" preserveAspectRatio="none" result="m"/>` +
    pass(0, 1.06) + pass(1, 1) + pass(2, 0.94) +
    `<feComposite in="c0" in2="c1" operator="arithmetic" k2="1" k3="1" result="rg"/>` +
    `<feComposite in="rg" in2="c2" operator="arithmetic" k2="1" k3="1"/>`;
  defs.appendChild(f);
  return `url(#${id})`;
}

function lensFor(w: number, h: number, r: number, dark: boolean): Lens {
  const key = `${Math.round(w)}x${Math.round(h)}r${Math.round(r)}${dark ? "d" : "l"}`;
  let lens = cache.get(key);
  if (!lens) {
    lens = build(w, h, r, dark);
    cache.set(key, lens);
  }
  return lens;
}

/**
 * Liga a lente numa peça. Use como ref do React (`ref={liquidGlass}`): devolve a limpeza.
 * Mede de novo quando a peça muda de tamanho (com folga, para não recalcular a cada quadro de uma animação)
 * e quando o tema troca.
 */
export function liquidGlass(el: HTMLElement | null): (() => void) | undefined {
  if (!el || off() || typeof ResizeObserver === "undefined") return;
  let timer = 0;
  let last = "";
  const apply = () => {
    timer = 0;
    if (off()) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w < 8 || h < 8) return;
    const r = Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    const dark = document.documentElement.dataset.theme === "dark";
    const key = `${w}x${h}r${r}${dark}`;
    if (key === last) return;
    last = key;
    const lens = lensFor(w, h, r, dark);
    el.style.setProperty("--lg-light", lens.light);
    if (lens.url) el.style.setProperty("--lg-refract", lens.url);
    el.classList.add("lg-lens");
    el.classList.toggle("lg-refract", !!lens.url);
  };
  const later = () => {
    clearTimeout(timer);
    timer = window.setTimeout(apply, last ? 160 : 0);
  };
  const ro = new ResizeObserver(later);
  ro.observe(el);
  const mo = new MutationObserver(later);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  later();
  return () => {
    clearTimeout(timer);
    ro.disconnect();
    mo.disconnect();
    el.classList.remove("lg-lens", "lg-refract");
  };
}
