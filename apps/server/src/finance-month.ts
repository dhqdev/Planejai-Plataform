import { one, query } from "./db/pool.js";

/**
 * Mês financeiro: cada pessoa escolhe o dia em que o mês dela começa (users.finance_month_start, 1 a 28).
 * Com dia 5, o mês "2026-11" vai de 5/nov a 4/dez. O nome do mês é o do dia em que ele começa.
 * Dia 1 = mês do calendário (o padrão), e aí nada muda em relação ao que era.
 */
export const MONTH_START_MAX = 28;

export function clampStart(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= MONTH_START_MAX ? n : 1;
}

/** Dia em que o mês financeiro da pessoa começa (1 se ela nunca escolheu). */
export async function monthStartOf(userId: string): Promise<number> {
  const r = await one<{ s: number }>("SELECT finance_month_start AS s FROM users WHERE id = $1", [userId]).catch(() => null);
  return clampStart(r?.s ?? 1);
}

export async function setMonthStart(userId: string, day: number) {
  const d = clampStart(day);
  await query("UPDATE users SET finance_month_start = $2 WHERE id = $1", [userId, d]);
  return d;
}

/**
 * Expressão SQL do mês financeiro (AAAA-MM) de uma data: tira (dia - 1) dias da data local, então o dia de
 * início cai no dia 1 do mês certo. `start` vem sempre de clampStart (inteiro 1..28), nunca do usuário cru.
 */
export function monthSql(col: string, tz: string, start: number): string {
  const s = clampStart(start);
  return s === 1 ? `to_char(${col} AT TIME ZONE ${tz}, 'YYYY-MM')` : `to_char((${col} AT TIME ZONE ${tz}) - interval '${s - 1} days', 'YYYY-MM')`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** Mês financeiro (AAAA-MM) em que a data cai. */
export function financeMonthOf(date: Date, tz: string, start: number): string {
  const [y, m, d] = localDay(date, tz).split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d - (clampStart(start) - 1)));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`;
}

/** Soma meses a um AAAA-MM. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** Primeiro e último dia (AAAA-MM-DD, local) do mês financeiro, e quantos dias ele tem. */
export function periodOf(month: string, start: number) {
  const s = clampStart(start);
  const [y, m] = month.split("-").map(Number) as [number, number];
  const from = new Date(Date.UTC(y, m - 1, s));
  const to = new Date(Date.UTC(y, m, s - 1));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: s, from: iso(from), to: iso(to), days: Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1 };
}

const MON = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
/** "5/nov a 4/dez" (dia 1: vazio, o nome do mês já basta). */
export function periodText(month: string, start: number): string {
  if (clampStart(start) === 1) return "";
  const p = periodOf(month, start);
  const f = (iso: string) => `${Number(iso.slice(8))}/${MON[Number(iso.slice(5, 7)) - 1]}`;
  return `${f(p.from)} a ${f(p.to)}`;
}
