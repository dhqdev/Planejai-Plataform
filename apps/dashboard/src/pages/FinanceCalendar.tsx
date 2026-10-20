import { useState, type ReactNode } from "react";
import { brl } from "../api";
import { haptic } from "../touch";
import "../styles/financas-calendario.css";

type Day = { day: number | string; expenses?: number | string | null; income?: number | string | null };

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

/** Calendário do mês em Finanças: quanto saiu em cada dia, com a cor pelo tamanho do gasto. */
export function FinanceCalendar({
  month,
  daily,
  income,
  expenses,
  limit,
  transactions,
  renderTx,
}: {
  month: string;
  daily: Day[];
  income: number;
  expenses: number;
  limit?: { limit: number; spent: number } | null;
  transactions: any[];
  renderTx: (t: any) => ReactNode;
}) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const daysIn = new Date(y, m, 0).getDate();
  const now = new Date();
  const isCurrent = now.getFullYear() === y && now.getMonth() + 1 === m;
  const today = isCurrent ? now.getDate() : 0;
  const [sel, setSel] = useState<number | null>(isCurrent ? today : null);

  const out = new Map<number, number>();
  const inc = new Map<number, number>();
  for (const d of daily) {
    out.set(Number(d.day), Number(d.expenses ?? 0));
    inc.set(Number(d.day), Number(d.income ?? 0));
  }
  const ref = limit?.limit ? limit.limit / daysIn : median([...out.values()]);
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const balance = income - expenses;

  const selTx = sel ? transactions.filter((t) => new Date(t.occurred_at).getDate() === sel && new Date(t.occurred_at).getMonth() + 1 === m) : [];
  const selOut = sel ? out.get(sel) ?? 0 : 0;
  const selIn = sel ? inc.get(sel) ?? 0 : 0;
  const selLabel = sel
    ? (() => {
        const s = new Date(y, m - 1, sel).toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
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
        {Array.from({ length: daysIn }, (_, i) => {
          const d = i + 1;
          const v = out.get(d) ?? 0;
          const lv = spendLevel(v, ref);
          const future = isCurrent && d > today;
          return (
            <button
              key={d}
              role="gridcell"
              className={`fcal-day l${lv}${d === today ? " today" : ""}${sel === d ? " sel" : ""}${future ? " future" : ""}`}
              aria-label={`Dia ${d}: ${v ? `${brl(v)} de gasto, ${LEVEL_LABEL[lv]}` : "sem gasto"}${inc.get(d) ? `, entrou ${brl(inc.get(d))}` : ""}`}
              aria-selected={sel === d}
              onClick={() => { haptic(4); setSel(sel === d ? null : d); }}
            >
              <span className="n">{d}</span>
              {v > 0 && <span className="v">{cellMoney(v)}</span>}
              {(inc.get(d) ?? 0) > 0 && <i className="inc" aria-hidden />}
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
