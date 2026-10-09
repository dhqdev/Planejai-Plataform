import { getCredentials } from "./integrations/registry.js";
import { config } from "./config.js";

/**
 * Gráficos sem IA e sem biblioteca: os números vêm do banco, o desenho é um SVG montado aqui
 * e vira PNG no navegador da stack (Browserless) ou no Chrome local. Sai em ~1s e não gasta token.
 */

/** Paleta do Planejai: laranja, coral, magenta e roxo, usados em pontos de destaque. */
// cores do Mochi, iguais às do painel: roxo elétrico, magenta, noite e tons entre eles; cinzas para o resto
export const PALETTE = ["#6510E0", "#C42BEA", "#210552", "#8B5CF6", "#A21CAF", "#4A3A8C", "#141414", "#7A7A75", "#B5B5AF", "#D9D9D4"];
/** vermelho só para o que estourou e âmbar para o alerta de 80% (sinal, não marca) */
const DANGER = "#E03150";
const WARN = "#F59E0B";
const INK = "#141414";
const MUTED = "#7A7A75";
const GRID = "#ECECE8";
const W = 1080;

export interface Slice {
  label: string;
  value: number;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const money = (n: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n).replace(/ /g, " ");
const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(".", ",")} mil` : String(Math.round(n)));

function frame(title: string, subtitle: string, body: string, height: number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="Inter, 'Segoe UI', Roboto, Arial, sans-serif">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6510E0"/><stop offset="1" stop-color="#C42BEA"/></linearGradient></defs>
  <rect width="${W}" height="${height}" rx="36" fill="#FFFFFF"/>
  <rect x="56" y="56" width="64" height="8" rx="4" fill="url(#g)"/>
  <text x="56" y="118" font-size="40" font-weight="700" fill="${INK}">${esc(title)}</text>
  <text x="56" y="160" font-size="26" fill="${MUTED}">${esc(subtitle)}</text>
  ${body}
  <text x="${W - 56}" y="${height - 36}" font-size="20" fill="#B5B5AF" text-anchor="end">planejai</text>
</svg>`;
}

/** Rosca com legenda: gastos por categoria. */
export function donutChart(title: string, subtitle: string, slices: Slice[]) {
  const items = slices.filter((s) => s.value > 0).slice(0, 8);
  const total = items.reduce((a, s) => a + s.value, 0) || 1;
  const cx = 290;
  const cy = 440;
  const r = 190;
  const c = 2 * Math.PI * r;
  let off = 0;
  const arcs = items
    .map((s, i) => {
      const len = (s.value / total) * c;
      const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${PALETTE[i % PALETTE.length]}" stroke-width="64" stroke-dasharray="${Math.max(0, len - 4)} ${c}" stroke-dashoffset="${-off}" transform="rotate(-90 ${cx} ${cy})"/>`;
      off += len;
      return el;
    })
    .join("");
  const legend = items
    .map((s, i) => {
      const y = 260 + i * 66;
      const pct = Math.round((s.value / total) * 100);
      return `<rect x="560" y="${y - 22}" width="26" height="26" rx="8" fill="${PALETTE[i % PALETTE.length]}"/>
      <text x="604" y="${y}" font-size="28" fill="${INK}">${esc(s.label)}</text>
      <text x="1024" y="${y}" font-size="28" font-weight="700" fill="${INK}" text-anchor="end">${money(s.value)}</text>
      <text x="604" y="${y + 28}" font-size="20" fill="${MUTED}">${pct}%</text>`;
    })
    .join("");
  const center = `<text x="${cx}" y="${cy - 6}" font-size="22" fill="${MUTED}" text-anchor="middle">total</text>
    <text x="${cx}" y="${cy + 34}" font-size="38" font-weight="700" fill="${INK}" text-anchor="middle">${money(total)}</text>`;
  return frame(title, subtitle, arcs + center + legend, Math.max(760, 260 + items.length * 66 + 80));
}

/** Barras verticais (meses ou dias). `highlight` pinta a última barra com o degradê. */
export function barChart(title: string, subtitle: string, bars: Slice[], opts: { highlightLast?: boolean; limit?: number } = {}) {
  const h = 720;
  const top = 220;
  const bottom = h - 110;
  const left = 110;
  const right = W - 56;
  const max = Math.max(1, opts.limit ?? 0, ...bars.map((b) => b.value)) * 1.12;
  const bw = (right - left) / Math.max(1, bars.length);
  const y = (v: number) => bottom - (v / max) * (bottom - top);
  const grid = [0.25, 0.5, 0.75, 1]
    .map((f) => `<line x1="${left}" x2="${right}" y1="${y(max * f / 1.12)}" y2="${y(max * f / 1.12)}" stroke="${GRID}" stroke-width="2"/>
      <text x="${left - 14}" y="${y(max * f / 1.12) + 8}" font-size="20" fill="${MUTED}" text-anchor="end">${short(max * f / 1.12)}</text>`)
    .join("");
  const showValues = bars.length <= 12;
  const rects = bars
    .map((b, i) => {
      const x = left + i * bw + bw * 0.18;
      const w = bw * 0.64;
      const last = i === bars.length - 1 && opts.highlightLast;
      const fill = last ? "url(#g)" : opts.limit && b.value > opts.limit ? DANGER : "#D9D9D4";
      const label = bars.length > 16 ? (i % 5 === 0 || i === bars.length - 1 ? b.label : "") : b.label;
      return `<rect x="${x}" y="${y(b.value)}" width="${w}" height="${Math.max(0, bottom - y(b.value))}" rx="${Math.min(14, w / 3)}" fill="${fill}"/>
      ${label ? `<text x="${x + w / 2}" y="${bottom + 40}" font-size="22" fill="${MUTED}" text-anchor="middle">${esc(label)}</text>` : ""}
      ${showValues && b.value > 0 ? `<text x="${x + w / 2}" y="${y(b.value) - 12}" font-size="20" font-weight="600" fill="${INK}" text-anchor="middle">${short(b.value)}</text>` : ""}`;
    })
    .join("");
  const limit = opts.limit
    ? `<line x1="${left}" x2="${right}" y1="${y(opts.limit)}" y2="${y(opts.limit)}" stroke="${DANGER}" stroke-width="3" stroke-dasharray="10 8"/>
       <text x="${right}" y="${y(opts.limit) - 10}" font-size="20" fill="${DANGER}" text-anchor="end">limite ${money(opts.limit)}</text>`
    : "";
  return frame(title, subtitle, grid + rects + limit, h);
}

/** Barras horizontais de progresso: quanto de cada limite já foi usado. */
export function budgetChart(title: string, subtitle: string, rows: { label: string; spent: number; limit: number }[]) {
  const items = rows.slice(0, 8);
  const h = Math.max(520, 240 + items.length * 96 + 60);
  const body = items
    .map((r, i) => {
      const y = 240 + i * 96;
      const pct = r.limit ? r.spent / r.limit : 0;
      const w = 968;
      const fill = pct >= 1 ? DANGER : pct >= 0.8 ? WARN : "url(#g)";
      return `<text x="56" y="${y}" font-size="28" fill="${INK}">${esc(r.label)}</text>
      <text x="1024" y="${y}" font-size="24" fill="${MUTED}" text-anchor="end">${money(r.spent)} de ${money(r.limit)} · ${Math.round(pct * 100)}%</text>
      <rect x="56" y="${y + 18}" width="${w}" height="20" rx="10" fill="${GRID}"/>
      <rect x="56" y="${y + 18}" width="${Math.max(20, Math.min(1, pct) * w)}" height="20" rx="10" fill="${fill}"/>`;
    })
    .join("");
  return frame(title, subtitle, body, h);
}

/** SVG -> PNG (base64) no navegador da stack, ou no Chrome local em dev. */
export async function svgToPng(svg: string): Promise<string> {
  const size = svg.match(/width="(\d+)" height="(\d+)"/);
  const width = Number(size?.[1] ?? W);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#F6F6F4}svg{display:block}</style></head><body>${svg}</body></html>`;
  return htmlToPng(html, width);
}

/** HTML -> PNG (base64) da página inteira, na largura dada (altura acompanha o conteúdo). */
export async function htmlToPng(html: string, width: number): Promise<string> {
  const b = await getCredentials("browserless");
  if (b?.url) {
    const url = `${b.url.replace(/\/$/, "")}/chromium/screenshot${b.token ? `?token=${encodeURIComponent(b.token)}` : ""}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html, options: { type: "png", fullPage: true, omitBackground: false }, viewport: { width, height: 600, deviceScaleFactor: 1 } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Browserless ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer()).toString("base64");
  }
  if (!config.CHROME_PATH) throw new Error("Para gerar imagem preciso do navegador da stack (Browserless) ou de CHROME_PATH.");
  const puppeteer = (await import("puppeteer-core")).default;
  const browser = await puppeteer.launch({ executablePath: config.CHROME_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 600, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    const buf = await page.screenshot({ type: "png", fullPage: true });
    return Buffer.from(buf).toString("base64");
  } finally {
    await browser.close().catch(() => {});
  }
}

/** HTML -> PDF A4 (várias páginas, a paginação é do navegador), com rodapé repetido em toda página. */
export async function htmlToPdf(html: string, footer: string): Promise<Buffer> {
  const options = { format: "A4", printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: footer };
  const b = await getCredentials("browserless");
  if (b?.url) {
    const url = `${b.url.replace(/\/$/, "")}/chromium/pdf${b.token ? `?token=${encodeURIComponent(b.token)}` : ""}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html, options }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Browserless ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (!config.CHROME_PATH) throw new Error("Para gerar PDF preciso do navegador da stack (Browserless) ou de CHROME_PATH.");
  const puppeteer = (await import("puppeteer-core")).default;
  const browser = await puppeteer.launch({ executablePath: config.CHROME_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return Buffer.from(await page.pdf({ ...options, format: "a4" }));
  } finally {
    await browser.close().catch(() => {});
  }
}
