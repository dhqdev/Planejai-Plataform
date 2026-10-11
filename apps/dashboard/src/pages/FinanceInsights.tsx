import { useRef, useState, type PointerEvent } from "react";
import { brl } from "../api";
import { Icon } from "../icons";
import { haptic } from "../touch";
import "../styles/finance-economia.css";

/** O que o servidor calcula em `finance-insights.ts` (valores em reais com 2 casas). */
export type Analysis = {
  month: string;
  isCurrent: boolean;
  daysIn: number;
  elapsed: number;
  spent: number;
  avgMonth: number | null;
  historyMonths: number;
  totals: { income: number; expenses: number; balance: number; rate: number | null };
  savings: { month: string; income: number; expenses: number; balance: number; rate: number | null }[];
  projection: { expected: number; pendingFixed: number; pace: number; avgMonth: number | null; vsAvg: number | null } | null;
  pace: { days: { day: number; actual: number | null; avg: number | null }[]; today: number | null; expected: number | null };
  changes: { category: string; current: number; avg: number; delta: number; pct: number | null }[];
  recurring: { name: string; category: string; monthly: number; yearly: number; months: number; chargedThisMonth: boolean; kind: "assinatura" | "fixo" }[];
  recurringTotal: number;
  tips: { id: string; icon: string; title: string; detail: string; saving: number; category: string | null }[];
  potential: number;
  split: { essential: number; flexible: number; flexibleTop: { category: string; total: number }[] };
  weekdays: { day: string; total: number; share: number }[];
  topDay: { day: string; total: number; share: number } | null;
  weekendShare: number | null;
  headline: string;
};

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const short = (m: string) => MONTHS[Number(m.slice(5)) - 1] ?? m;
/** Valor curto para eixo e rótulo apertado: R$ 1,2 mil. */
const compact = (v: number) => (Math.abs(v) < 1000 ? brl(v).replace(/,00$/, "") : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", notation: "compact", maximumFractionDigits: 1 }).format(v));
/** Rótulo de barra estreita, sem "R$" (o título já diz): 843, 1,5 mil. */
const tiny = (v: number) => `${v < 0 ? "−" : ""}${Math.abs(v) < 1000 ? Math.round(Math.abs(v)) : new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 }).format(Math.abs(v))}`;
const long = (v: number) => (brl(v).length > 12 ? " long" : "");

/** Faixa de cima: o que importa para guardar dinheiro, no lugar de entrada/saída/média por dia. */
export function SavingsKpis({ a }: { a: Analysis }) {
  const { totals, projection } = a;
  return (
    <div className="card fin-kpis fx-kpis">
      <div>
        <small>Sobrou no mês</small>
        <strong className={`${totals.balance < 0 ? "neg" : totals.balance > 0 ? "pos" : ""}${long(totals.balance)}`}>{brl(totals.balance)}</strong>
        <span>{totals.rate != null ? (totals.rate >= 0 ? `guardou ${totals.rate}% do que entrou` : "saiu mais do que entrou") : totals.expenses ? "nenhuma entrada lançada" : "sem lançamentos"}</span>
      </div>
      {projection ? (
        <div>
          <small>Projeção do mês</small>
          <strong className={long(projection.expected)}>{brl(projection.expected)}</strong>
          <span>{projection.vsAvg != null && Math.abs(projection.vsAvg) >= 1 ? <><b className={projection.vsAvg > 0 ? "up" : "down"}>{projection.vsAvg > 0 ? "+" : "−"}{compact(Math.abs(projection.vsAvg))}</b> vs sua média</> : `já foram ${brl(a.spent)}`}</span>
        </div>
      ) : (
        <div>
          <small>Gasto do mês</small>
          <strong className={long(totals.expenses)}>{brl(totals.expenses)}</strong>
          <span>{a.avgMonth != null && Math.abs(totals.expenses - a.avgMonth) >= 1 ? <><b className={totals.expenses > a.avgMonth ? "up" : "down"}>{totals.expenses > a.avgMonth ? "+" : "−"}{compact(Math.abs(totals.expenses - a.avgMonth))}</b> vs sua média</> : "mês fechado"}</span>
        </div>
      )}
      <div>
        <small>Dá para economizar</small>
        <strong className={`${a.potential ? "pos" : ""}${long(a.potential)}`}>{brl(a.potential)}</strong>
        <span>{a.potential ? `por mês, ${compact(a.potential * 12)} no ano` : "nada fora da curva"}</span>
      </div>
      <div>
        <small>Fixos e assinaturas</small>
        <strong className={long(a.recurringTotal)}>{brl(a.recurringTotal)}</strong>
        <span>{a.recurring.length ? `${a.recurring.length} ${a.recurring.length === 1 ? "cobrança" : "cobranças"} todo mês` : "nenhuma achada ainda"}</span>
      </div>
    </div>
  );
}

/** Dicas concretas de corte, com o valor estimado por mês. */
export function SavingsTips({ a, onCategory }: { a: Analysis; onCategory: (c: string) => void }) {
  return (
    <div className="card fx-card fx-tips">
      <div className="fin-card-head">
        <span className="tone-ico" style={{ ["--c" as any]: "var(--ok)" }}><Icon name="target" size={15} /></span>
        <h3>Onde dá para economizar</h3>
        <span className="chip-mini">sem IA</span>
      </div>
      <p className="fx-headline">{a.headline}</p>
      {a.tips.length > 0 && (
        <ol className="fx-tip-list">
          {a.tips.map((t) => (
            <li key={t.id}>
              <button disabled={!t.category} onClick={() => { if (t.category) { haptic(5); onCategory(t.category); } }}>
                <span className="fx-tip-ico"><Icon name={t.icon} size={16} /></span>
                <span className="fx-tip-text">
                  <strong>{t.title}</strong>
                  <small>{t.detail}</small>
                </span>
                <span className="fx-tip-save"><b>−{brl(t.saving)}</b><small>por mês</small></span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {!a.tips.length && a.spent > 0 && (
        <p className="muted fx-empty">Nada fora da curva {a.isCurrent ? "até agora" : "neste mês"}. Com mais lançamentos eu acho assinaturas esquecidas, lugares que você vai muito e categorias que subiram.</p>
      )}
    </div>
  );
}

/** Gasto acumulado dia a dia contra a média dos meses anteriores, com a projeção até o fim do mês. */
export function PaceChart({ a }: { a: Analysis }) {
  const { days, today, expected } = a.pace;
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const n = days.length;
  const max = Math.max(1, ...days.map((d) => Math.max(d.actual ?? 0, d.avg ?? 0)), expected ?? 0) * 1.08;
  const W = 300;
  const H = 120;
  const x = (day: number) => ((day - 1) / Math.max(1, n - 1)) * W;
  const y = (v: number) => H - (v / max) * H;
  const path = (pts: [number, number][]) => pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
  const actual = days.filter((d) => d.actual != null).map((d) => [x(d.day), y(d.actual!)] as [number, number]);
  const avg = days.every((d) => d.avg != null) ? days.map((d) => [x(d.day), y(d.avg!)] as [number, number]) : null;
  const last = days.filter((d) => d.actual != null).pop();
  const proj = today && expected != null && last ? [[x(last.day), y(last.actual!)], [x(n), y(expected)]] as [number, number][] : null;
  const ticks = [0.5, 1].map((f) => (max / 1.08) * f);
  const move = (e: PointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setHover(Math.min(n, Math.max(1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)) + 1)));
  };
  const h = hover ? days[hover - 1] : null;
  return (
    <div className="card fx-card fx-pace">
      <div className="fin-card-head">
        <div>
          <h3>Ritmo do mês</h3>
          <small className="muted">Quanto já saiu, somado dia a dia</small>
        </div>
      </div>
      <div className="fx-legend">
          <span><i className="ln actual" />Este mês</span>
          {avg && <span><i className="ln avg" />Sua média</span>}
          {proj && <span><i className="ln proj" />Projeção</span>}
      </div>
      <div className="fx-pace-plot" ref={box} onPointerMove={move} onPointerDown={move} onPointerLeave={() => setHover(null)} role="img" aria-label={`Gasto acumulado: ${brl(a.spent)}${a.avgMonth != null ? `; média dos meses anteriores ${brl(a.avgMonth)}` : ""}${expected != null ? `; projeção ${brl(expected)}` : ""}`}>
        {ticks.map((t) => (
          <span key={t} className="fx-grid" style={{ bottom: `${(t / max) * 100}%` }}><small>{compact(t)}</small></span>
        ))}
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
          {avg && <path d={path(avg)} className="avg" vectorEffect="non-scaling-stroke" />}
          {actual.length > 0 && <path d={`${path(actual)}L${actual[actual.length - 1]![0]},${H}L0,${H}Z`} className="area" />}
          {actual.length > 0 && <path d={path(actual)} className="actual" vectorEffect="non-scaling-stroke" />}
          {proj && <path d={path(proj)} className="proj" vectorEffect="non-scaling-stroke" />}
        </svg>
        {last && <i className="fx-dot" style={{ left: `${(x(last.day) / W) * 100}%`, bottom: `${(last.actual! / max) * 100}%` }} />}
        {proj && <i className="fx-dot hollow" style={{ left: "100%", bottom: `${(expected! / max) * 100}%` }} />}
        {h && (
          <>
            <span className="fx-cross" style={{ left: `${(x(h.day) / W) * 100}%` }} />
            <span className={`fx-tip ${h.day > n / 2 ? "left" : ""}`} style={{ left: `${(x(h.day) / W) * 100}%` }}>
              <b>Dia {h.day}</b>
              {h.actual != null && <span><i className="ln actual" />{brl(h.actual)}</span>}
              {h.avg != null && <span><i className="ln avg" />{brl(h.avg)}</span>}
              {h.actual == null && expected != null && today && last && <span><i className="ln proj" />{brl(last.actual! + ((expected - last.actual!) * (h.day - last.day)) / Math.max(1, n - last.day))}</span>}
            </span>
          </>
        )}
      </div>
      <div className="fx-axis"><small>dia 1</small>{today && today > 4 && today < n - 4 && <small className="today" style={{ left: `${(x(today) / W) * 100}%` }}>hoje</small>}<small>dia {n}</small></div>
      {a.projection && (
        <p className="fx-note">
          {a.projection.pendingFixed > 0 ? <>Ainda vão cair <b>{brl(a.projection.pendingFixed)}</b> de contas fixas. </> : null}
          Fora isso, você gasta uns <b>{brl(a.projection.pace)}</b> por dia.
        </p>
      )}
    </div>
  );
}

/** Variação por categoria contra a média: barra para a direita subiu, para a esquerda caiu. */
export function ChangesChart({ a, onCategory }: { a: Analysis; onCategory: (c: string) => void }) {
  const list = [...a.changes].sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta)).slice(0, 7).sort((p, q) => q.delta - p.delta);
  const max = Math.max(1, ...list.map((c) => Math.abs(c.delta)));
  return (
    <div className="card fx-card fx-changes">
      <div className="fin-card-head">
        <div>
          <h3>O que mudou</h3>
          <small className="muted">{a.historyMonths ? `${a.isCurrent ? `Até o dia ${a.elapsed}, c` : "C"}ontra a média ${a.historyMonths === 1 ? "do mês anterior" : `dos ${a.historyMonths} meses anteriores`}` : "Comparação com os meses anteriores"}</small>
        </div>
      </div>
      {!a.historyMonths && <p className="muted fx-empty">Com um mês de histórico eu mostro o que subiu e o que caiu em cada categoria.</p>}
      {a.historyMonths > 0 && !list.length && <p className="muted fx-empty">Tudo igual à sua média.</p>}
      <div className="fx-div">
        {list.map((c) => (
          <button key={c.category} onClick={() => { haptic(5); onCategory(c.category); }} title={`${c.category}: ${brl(c.current)} agora, média ${brl(c.avg)}`}>
            <span className="name">{c.category}</span>
            <span className="track">
              <i className={c.delta > 0 ? "up" : "down"} style={{ width: `${(Math.abs(c.delta) / max) * 50}%` }} />
            </span>
            <span className={`val ${c.delta > 0 ? "up" : "down"}`}>{c.delta > 0 ? "+" : "−"}{compact(Math.abs(c.delta))}</span>
          </button>
        ))}
      </div>
      {list.length > 0 && <div className="fx-div-key"><span><small>◀ caiu</small><small>subiu ▶</small></span></div>}
    </div>
  );
}

/** Cobranças que se repetem todo mês: assinaturas e contas fixas, com o custo no ano. */
export function RecurringCard({ a }: { a: Analysis }) {
  const [all, setAll] = useState(false);
  const list = all ? a.recurring : a.recurring.slice(0, 5);
  return (
    <div className="card fx-card fx-recurring">
      <div className="fin-card-head">
        <span className="tone-ico" style={{ ["--c" as any]: "var(--violet)" }}><Icon name="repeat" size={15} /></span>
        <h3>Gastos que se repetem</h3>
        <span className="spacer" />
        {a.recurring.length > 0 && <strong className="fx-year">{compact(a.recurringTotal * 12)}<small>/ano</small></strong>}
      </div>
      {list.map((r) => (
        <div key={r.name} className="fx-rec">
          <span className={`fx-rec-tag ${r.kind}`}>{r.kind === "assinatura" ? "assinatura" : "fixo"}</span>
          <span className="fx-rec-name">
            <span className="ellipsis" title={r.name}>{r.name}</span>
            <small>{r.category}{a.isCurrent && !r.chargedThisMonth ? " · ainda não caiu" : ""}</small>
          </span>
          <span className="fx-rec-val"><b>{brl(r.monthly)}</b><small>{compact(r.yearly)} no ano</small></span>
        </div>
      ))}
      {a.recurring.length > 5 && <button className="link-btn" onClick={() => setAll(!all)}>{all ? "Mostrar menos" : `Ver todas (${a.recurring.length})`}</button>}
      {!a.recurring.length && <p className="muted fx-empty">Quando a mesma cobrança aparecer em dois meses (streaming, academia, aluguel) ela entra aqui com o custo no ano.</p>}
    </div>
  );
}

/** Essencial x flexível no mês e o dia da semana em que os gastos soltos acontecem. */
export function SpendingShape({ a }: { a: Analysis }) {
  const { essential, flexible, flexibleTop } = a.split;
  const total = essential + flexible;
  const maxWd = Math.max(1, ...a.weekdays.map((w) => w.total));
  return (
    <div className="card fx-card fx-shape">
      <div className="fin-card-head"><h3>Como você gasta</h3></div>
      {total > 0 ? (
        <>
          <div className="fx-split" role="img" aria-label={`Essencial ${brl(essential)}, flexível ${brl(flexible)}`}>
            {essential > 0 && <i className="ess" style={{ flexGrow: essential }} />}
            {flexible > 0 && <i className="flex" style={{ flexGrow: flexible }} />}
          </div>
          <div className="fx-split-key">
            <span><i className="ess" />Essencial <b>{Math.round((essential / total) * 100)}%</b><small>{brl(essential)}</small></span>
            <span><i className="flex" />Flexível <b>{Math.round((flexible / total) * 100)}%</b><small>{brl(flexible)}</small></span>
          </div>
          {flexibleTop.length > 0 && <p className="fx-note">No flexível, onde dá para cortar: {flexibleTop.map((c, i) => <span key={c.category}>{i ? ", " : ""}<b>{c.category}</b> {compact(c.total)}</span>)}.</p>}
        </>
      ) : (
        <p className="muted fx-empty">Sem gastos neste mês.</p>
      )}
      {a.topDay && (
        <>
          <div className="fx-week">
            {a.weekdays.map((w) => (
              <span key={w.day} className={w.day === a.topDay!.day ? "top" : ""} title={`${w.day}: ${brl(w.total)} (${w.share}%)`}>
                <i style={{ height: `${Math.max(3, (w.total / maxWd) * 100)}%` }} />
                <small>{w.day.slice(0, 3)}</small>
              </span>
            ))}
          </div>
          <p className="fx-note"><b>{a.topDay.day.charAt(0).toUpperCase() + a.topDay.day.slice(1)}</b> é o dia em que você mais gasta solto ({a.topDay.share}%). Fim de semana: {a.weekendShare}%.</p>
        </>
      )}
    </div>
  );
}

/** Quanto sobrou (ou faltou) em cada um dos últimos 6 meses. Tocar num mês abre ele. */
export function SavingsTrend({ a, onMonth }: { a: Analysis; onMonth: (m: string) => void }) {
  const max = Math.max(1, ...a.savings.map((s) => Math.abs(s.balance)));
  const hasNeg = a.savings.some((s) => s.balance < 0);
  const hasPos = a.savings.some((s) => s.balance > 0);
  const zero = hasNeg && hasPos ? 50 : hasNeg ? 0 : 100;
  return (
    <div className="card fx-card fx-trend">
      <div className="fin-card-head">
        <div>
          <h3>Quanto sobrou</h3>
          <small className="muted">Entradas menos saídas, em reais, mês a mês</small>
        </div>
      </div>
      <div className="fx-bars" style={{ ["--zero" as any]: `${zero}%` }}>
        {a.savings.map((s) => {
          const hpct = (Math.abs(s.balance) / max) * (hasNeg && hasPos ? 50 : 100);
          return (
            <button key={s.month} className={s.month === a.month ? "active" : ""} onClick={() => { haptic(5); onMonth(s.month); }} title={`${short(s.month)}: entrou ${brl(s.income)}, saiu ${brl(s.expenses)}`}>
              <span className="plot">
                {s.balance !== 0 && <i className={s.balance > 0 ? "pos" : "neg"} style={s.balance > 0 ? { bottom: `${zero}%`, height: `${hpct}%` } : { top: `${100 - zero}%`, height: `${hpct}%` }} />}
              </span>
              <b className={s.balance < 0 ? "neg" : ""}>{s.income || s.expenses ? tiny(s.balance) : "–"}</b>
              <small>{short(s.month)}{s.rate != null ? ` · ${s.rate}%` : ""}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}
