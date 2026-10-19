import { brl } from "../api";
import "../styles/chat-cartoes.css";

/**
 * Cartões do chat do Início: o servidor monta (chat-cards.ts) e a tela só desenha. Calendário quando a conversa
 * é de agenda, mini painel quando é de dinheiro. Sem emoji, sem degradê; o roxo só marca o dia de hoje e o limite.
 */
export interface AgendaCardData {
  type: "agenda";
  agent: "agenda";
  month: string;
  today: number | null;
  marks: number[];
  items: { day: number; month: string; weekday: string; time: string; title: string }[];
}
export interface MoneyCardData {
  type: "dinheiro";
  agent: "financeiro";
  month: string;
  spent: number;
  income: number;
  prev: number;
  limit: number | null;
  cats: { name: string; total: number }[];
  week: { day: string; total: number }[];
}
export type ChatCardData = AgendaCardData | MoneyCardData;

const monthName = (ym: string, long = true) =>
  new Date(`${ym}-01T12:00:00`).toLocaleDateString("pt-BR", { month: long ? "long" : "short" }).replace(".", "");
const INITIALS = ["D", "S", "T", "Q", "Q", "S", "S"];

export function AgendaCard({ card }: { card: AgendaCardData }) {
  const [y, m] = card.month.split("-").map(Number) as [number, number];
  const first = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();
  const marks = new Set(card.marks);
  const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  return (
    <div className="cc cc-agenda" role="group" aria-label={`Calendário de ${monthName(card.month)}`}>
      <div className="cc-head">
        <strong>{monthName(card.month)}</strong>
        <span>{y}</span>
      </div>
      <div className="cc-cal" aria-hidden="true">
        {INITIALS.map((d, i) => (
          <i key={i} className="cc-wd">{d}</i>
        ))}
        {cells.map((d, i) =>
          d === null ? (
            <i key={i} />
          ) : (
            <span key={i} className={`cc-day${d === card.today ? " today" : ""}${marks.has(d) ? " mark" : ""}`}>{d}</span>
          ),
        )}
      </div>
      {card.items.length > 0 ? (
        <ul className="cc-items">
          {card.items.map((it, i) => (
            <li key={i}>
              <span className="cc-when">{it.weekday} {it.day}{it.month !== card.month ? `/${it.month.slice(5)}` : ""}</span>
              <span className="cc-what">{it.title}</span>
              <time>{it.time}</time>
            </li>
          ))}
        </ul>
      ) : (
        <p className="cc-none">Nada marcado pela frente.</p>
      )}
    </div>
  );
}

export function MoneyCard({ card }: { card: MoneyCardData }) {
  const top = card.cats.reduce((n, c) => Math.max(n, c.total), 0) || 1;
  const peak = card.week.reduce((n, d) => Math.max(n, d.total), 0) || 1;
  const delta = card.prev > 0 ? Math.round(((card.spent - card.prev) / card.prev) * 100) : null;
  const pct = card.limit ? Math.min(100, Math.round((card.spent / card.limit) * 100)) : 0;
  const prevName = monthName(new Date(Number(card.month.slice(0, 4)), Number(card.month.slice(5)) - 2, 1).toISOString().slice(0, 7));
  return (
    <div className="cc cc-money" role="group" aria-label={`Gastos de ${monthName(card.month)}`}>
      <div className="cc-head">
        <strong>Gastos de {monthName(card.month)}</strong>
      </div>
      <div className="cc-big">{brl(card.spent)}</div>
      <p className="cc-sub">
        {delta === null ? "Sem mês anterior para comparar" : delta === 0 ? `Igual a ${prevName} até aqui` : `${Math.abs(delta)}% ${delta > 0 ? "acima" : "abaixo"} de ${prevName} até aqui`}
        {card.income > 0 && <> · entrou {brl(card.income)}</>}
      </p>
      {card.limit ? (
        <div className="cc-limit">
          <div className="cc-track" role="img" aria-label={`${pct}% do limite`}><i style={{ width: `${pct}%` }} /></div>
          <span>{pct}% do limite de {brl(card.limit)}</span>
        </div>
      ) : null}
      {card.cats.length > 0 && (
        <ul className="cc-cats">
          {card.cats.map((c) => (
            <li key={c.name}>
              <span className="cc-cat">{c.name}</span>
              <span className="cc-bar"><i style={{ width: `${Math.max(4, (c.total / top) * 100)}%` }} /></span>
              <b>{brl(c.total)}</b>
            </li>
          ))}
        </ul>
      )}
      <div className="cc-week" aria-label="Gasto dos últimos 7 dias">
        {card.week.map((d, i) => (
          <div key={d.day} className={i === card.week.length - 1 ? "now" : undefined} title={`${d.day.slice(8)}/${d.day.slice(5, 7)}: ${brl(d.total)}`}>
            <i style={{ height: `${Math.max(d.total ? 8 : 3, (d.total / peak) * 100)}%` }} />
            <span>{INITIALS[new Date(`${d.day}T12:00:00`).getDay()]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChatCard({ card }: { card: ChatCardData }) {
  return card.type === "agenda" ? <AgendaCard card={card} /> : <MoneyCard card={card} />;
}
