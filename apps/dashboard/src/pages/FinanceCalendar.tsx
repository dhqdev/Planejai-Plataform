import { useState, type ReactNode } from "react";
import { brl } from "../api";
import { haptic } from "../touch";
import "../styles/financas-calendario.css";

type Day = { date?: string; day: number | string; expenses?: number | string | null; income?: number | string | null };

const MON = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const pad = (n: number) => String(n).padStart(2, "0");
/** AAAA-MM-DD no relógio do aparelho. */
export const localIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = (iso: string) => new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

/** Valor curto dentro do quadradinho do dia: 85, 1,2 mil. O valor exato aparece ao tocar no dia. */
const MIL1 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const MIL0 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const cellMoney = (v: number) => (v < 1000 ? String(Math.round(v)) : `${(v < 10000 ? MIL1 : MIL0).format(v / 1000)} mil`);

/**
 * Nível de 1 a 4 do gasto do dia. A régua é o limite do mês dividido pelos dias (quando há limite total)
 * ou o dia típico do mês (mediana dos dias com gasto), assim um aluguel não deixa todo o resto "pouco".
 */
export function spendLevel(v: number, ref: number) {
  if (v <= 0) return 0;
  const r = v / Math.max(ref, 0.01);
  return r <= 0.5 ? 1 : r <= 1.1 ? 2 : r <= 2 ? 3 : 4;
}

export function median(values: number[]) {
  const s = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const WD = ["S", "T", "Q", "Q", "S", "S", "D"];
const LEVEL_LABEL = ["", "pouco", "normal", "acima do normal", "muito"];

/**
 * Calendário do mês em Finanças: quanto saiu em cada dia, com a cor pelo tamanho do gasto.
 * O mês é o da pessoa: com início no dia 5 vai de 5 deste mês a 4 do próximo (from + days).
 */
export function FinanceCalendar({
  month,
  from,
  days,
  footer,
  daily,
  income,
  expenses,
  limit,
  transactions,
  renderTx,
}: {
  month: string;
  /** Primeiro dia (AAAA-MM-DD) e quantos dias o mês financeiro tem; sem isso, o mês do calendário. */
  from?: string;
  days?: number;
  footer?: ReactNode;
  daily: Day[];
  income: number;
  expenses: number;
  limit?: { limit: number; spent: number } | null;
  transactions: any[];
  renderTx: (t: any) => ReactNode;
}) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const first = from ? parseIso(from) : new Date(y, m - 1, 1);
  const count = days ?? new Date(y, m, 0).getDate();
  const dates = Array.from({ length: count }, (_, i) => localIso(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i)));
  const todayIso = localIso(new Date());
  const isCurrent = dates.includes(todayIso);
  const today = isCurrent ? todayIso : "";
  const [sel, setSel] = useState<string | null>(isCurrent ? today : null);

  const out = new Map<string, number>();
  const inc = new Map<string, number>();
  for (const d of daily) {
    const k = d.date ?? `${month}-${pad(Number(d.day))}`;
    out.set(k, Number(d.expenses ?? 0));
    inc.set(k, Number(d.income ?? 0));
  }
  const ref = limit?.limit ? limit.limit / count : median([...out.values()]);
  const lead = (first.getDay() + 6) % 7;
  const balance = income - expenses;

  const selTx = sel ? transactions.filter((t) => localIso(new Date(t.occurred_at)) === sel) : [];
  const selOut = sel ? out.get(sel) ?? 0 : 0;
  const selIn = sel ? inc.get(sel) ?? 0 : 0;
  const selLabel = sel
    ? (() => {
        const s = parseIso(sel).toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
        return sel === today ? "Hoje" : s.charAt(0).toUpperCase() + s.slice(1);
      })()
    : "";

  return (
    <div className="card fcal">
      <div className="fcal-sum">
        <div><small><i className="in" />Entradas</small><strong>{brl(income)}</strong></div>
        <div><small><i className="out" />Saídas</small><strong>{brl(expenses)}</strong></div>
        <div><small><i className="bal" />Saldo</small><strong className={balance < 0 ? "neg" : ""}>{brl(balance)}</strong></div>
      </div>
      {limit && (
        <div className="fcal-limit">
          <span>Limite do mês</span>
          <span className={`fcal-limit-bar ${limit.spent > limit.limit ? "over" : ""}`}><i style={{ width: `${Math.min(100, (limit.spent / Math.max(limit.limit, 0.01)) * 100)}%` }} /></span>
          <strong className={limit.spent > limit.limit ? "neg" : ""}>{limit.spent > limit.limit ? `${brl(limit.spent - limit.limit)} acima` : `${brl(limit.limit - limit.spent)} livre`}</strong>
        </div>
      )}

      <div className="fcal-grid" role="grid" aria-label="Gastos por dia">
        {WD.map((w, i) => <span key={i} className="fcal-wd" aria-hidden>{w}</span>)}
        {Array.from({ length: lead }, (_, i) => <span key={`e${i}`} />)}
        {dates.map((iso, i) => {
          const d = Number(iso.slice(8, 10));
          const v = out.get(iso) ?? 0;
          const lv = spendLevel(v, ref);
          const future = isCurrent && iso > today;
          // o mês financeiro pode virar o mês do calendário no meio: o dia 1 mostra o mês novo
          const turn = d === 1 && i > 0;
          return (
            <button
              key={iso}
              role="gridcell"
              className={`fcal-day l${lv}${iso === today ? " today" : ""}${sel === iso ? " sel" : ""}${future ? " future" : ""}`}
              aria-label={`Dia ${d}${turn || i === 0 ? ` de ${MON[Number(iso.slice(5, 7)) - 1]}` : ""}: ${v ? `${brl(v)} de gasto, ${LEVEL_LABEL[lv]}` : "sem gasto"}${inc.get(iso) ? `, entrou ${brl(inc.get(iso))}` : ""}`}
              aria-selected={sel === iso}
              onClick={() => { haptic(4); setSel(sel === iso ? null : iso); }}
            >
              <span className="n">{d}{turn && <small className="fcal-mon">{MON[Number(iso.slice(5, 7)) - 1]}</small>}</span>
              {v > 0 && <span className="v">{cellMoney(v)}</span>}
              {(inc.get(iso) ?? 0) > 0 && <i className="inc" aria-hidden />}
            </button>
          );
        })}
      </div>

      <div className="fcal-legend" aria-hidden>
        <span>Pouco</span>
        <i className="l1" /><i className="l2" /><i className="l3" /><i className="l4" />
        <span>Muito</span>
        <span className="spacer" />
        <span className="fcal-legend-in"><i />entrada</span>
      </div>
      {footer}

      {sel != null && (
        <div className="fcal-sel" key={sel}>
          <div className="fcal-sel-head">
            <strong>{selLabel}</strong>
            <span>{selIn > 0 && <em>+{brl(selIn)}</em>}{selOut > 0 ? `−${brl(selOut)}` : selIn > 0 ? "" : "nada saiu"}</span>
          </div>
          {selTx.length > 0 && <div className="fcal-sel-list">{selTx.map((t) => renderTx(t))}</div>}
        </div>
      )}
    </div>
  );
}
