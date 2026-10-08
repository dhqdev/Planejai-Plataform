/* Formatos das Execuções: dinheiro, tempo, tokens e datas no jeito brasileiro. Só texto, sem React. */

/** Custo em dólar (como no OpenRouter), no jeito brasileiro: "US$ 0,0012". */
export function usdBR(v: number | string | null | undefined) {
  const n = Number(v ?? 0);
  const digits = n === 0 ? 2 : n < 0.0001 ? 6 : n < 1 ? 4 : 2;
  return `US$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function dur(v: number | null | undefined) {
  if (v == null) return "–";
  if (v < 1000) return `${v} ms`;
  if (v < 60_000) return `${(v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`;
  const m = Math.floor(v / 60_000);
  const s = Math.round((v % 60_000) / 1000);
  return s ? `${m} min ${s} s` : `${m} min`;
}

export function tok(v: number | string | null | undefined) {
  const n = Number(v ?? 0);
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: n < 10_000 ? 1 : 0 })} mil`;
  return `${(n / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
}

export function agoShort(iso: string | null | undefined) {
  if (!iso) return "–";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 45) return "agora";
  if (s < 3600) return `há ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} d`;
}

export const clock = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
export const fullWhen = (iso: string) => new Date(iso).toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }).replace(/\./g, "");

export function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Hoje";
  if (d.toDateString() === y.toDateString()) return "Ontem";
  const s = d.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Primeiras palavras de um texto, numa linha só. */
export function firstWords(text: string | null | undefined, words = 14) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  const parts = t.split(" ");
  return parts.length > words ? `${parts.slice(0, words).join(" ")}…` : t;
}

export const plural = (n: number, one: string, many: string) => `${n.toLocaleString("pt-BR")} ${n === 1 ? one : many}`;
export const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : "0%");
