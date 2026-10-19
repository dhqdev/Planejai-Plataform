import { saveAppMessage } from "./channels/app.js";
import { many, one } from "./db/pool.js";
import { reminderOccurrences } from "./reminders.js";
import { isoLocal, parseLocalDateTime } from "./time.js";

/**
 * Cartões do chat do app (aba Início): quando a conversa fala de agenda ou de dinheiro, a tela mostra um
 * calendário ou um mini painel em vez de só texto. Saem do banco, depois da resposta, sem pedir nada ao modelo
 * (zero token a mais) e só se a ferramenta rodou de verdade. A tela só desenha o que está aqui.
 */
export type AgendaCard = {
  type: "agenda";
  agent: "agenda";
  /** mês mostrado, AAAA-MM */
  month: string;
  /** dia de hoje (só quando o mês mostrado é o atual) */
  today: number | null;
  /** dias do mês com compromisso */
  marks: number[];
  items: { day: number; month: string; weekday: string; time: string; title: string }[];
};
export type MoneyCard = {
  type: "dinheiro";
  agent: "financeiro";
  month: string;
  spent: number;
  income: number;
  /** gasto do mês anterior até o mesmo dia, para a comparação */
  prev: number;
  limit: number | null;
  cats: { name: string; total: number }[];
  /** gasto dos últimos 7 dias, do mais antigo ao de hoje */
  week: { day: string; total: number }[];
};
export type ChatCard = AgendaCard | MoneyCard;

const AGENDA_TOOLS = ["schedule_reminder", "list_reminders", "cancel_reminder", "reschedule_reminder", "calendar_list_events", "calendar_create_event"];
const MONEY_TOOLS = ["add_transaction", "list_transactions", "finance_summary", "budget_status", "set_budget", "update_transaction", "delete_transaction", "bill_save", "bill_list", "bill_pay"];
const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** Quais cartões a rodada pede, pelas ferramentas que rodaram com sucesso. */
export function cardKinds(done: Iterable<string>): ("agenda" | "dinheiro")[] {
  const names = new Set(done);
  const out: ("agenda" | "dinheiro")[] = [];
  if (AGENDA_TOOLS.some((t) => names.has(t))) out.push("agenda");
  if (MONEY_TOOLS.some((t) => names.has(t))) out.push("dinheiro");
  return out;
}

export async function buildCards(userId: string, tz: string, kinds: ("agenda" | "dinheiro")[]): Promise<ChatCard[]> {
  const cards = await Promise.all(kinds.map((k) => (k === "agenda" ? agendaCard(userId, tz) : moneyCard(userId, tz)).catch(() => null)));
  return cards.filter((c): c is ChatCard => Boolean(c));
}

export async function agendaCard(userId: string, tz: string): Promise<AgendaCard | null> {
  const now = new Date();
  const today = isoLocal(now, tz).slice(0, 10);
  const from = parseLocalDateTime(`${today}T00:00`, tz);
  const occ = (await reminderOccurrences(from, new Date(from.getTime() + 60 * 86_400_000), userId))
    .filter((o) => new Date(o.start).getTime() >= from.getTime())
    .sort((a, b) => a.start.localeCompare(b.start));
  const upcoming = occ.filter((o) => new Date(o.start) >= new Date(now.getTime() - 3_600_000));
  const month = (upcoming[0] ? isoLocal(new Date(upcoming[0].start), tz) : today).slice(0, 7);
  const local = (iso: string) => isoLocal(new Date(iso), tz);
  const marks = [...new Set(occ.filter((o) => local(o.start).startsWith(month)).map((o) => Number(local(o.start).slice(8, 10))))].sort((a, b) => a - b);
  return {
    type: "agenda",
    agent: "agenda",
    month,
    today: today.startsWith(month) ? Number(today.slice(8, 10)) : null,
    marks,
    items: upcoming.slice(0, 4).map((o) => {
      const l = local(o.start);
      return {
        day: Number(l.slice(8, 10)),
        month: l.slice(0, 7),
        weekday: WEEKDAYS[new Date(`${l.slice(0, 10)}T12:00:00Z`).getUTCDay()]!,
        time: l.slice(11, 16),
        title: String(o.title).replace(/\s*\(criado pelo painel\)$/, "").slice(0, 60),
      };
    }),
  };
}

export async function moneyCard(userId: string, tz: string): Promise<MoneyCard | null> {
  const today = isoLocal(new Date(), tz).slice(0, 10);
  const month = today.slice(0, 7);
  const dom = Number(today.slice(8, 10));
  const day = "to_char(occurred_at AT TIME ZONE $2, 'YYYY-MM-DD')";
  const [tot, cats, week, budget] = await Promise.all([
    one(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'expense' AND ${day} LIKE $3 || '%'), 0)::float8 AS spent,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'income' AND ${day} LIKE $3 || '%'), 0)::float8 AS income,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'expense' AND to_char(occurred_at AT TIME ZONE $2, 'YYYY-MM') = to_char(($3 || '-01')::date - interval '1 month', 'YYYY-MM')
                                           AND to_char(occurred_at AT TIME ZONE $2, 'DD')::int <= $4), 0)::float8 AS prev
         FROM transactions WHERE user_id = $1`,
      [userId, tz, month, dom],
    ),
    many(
      `SELECT category AS name, SUM(amount)::float8 AS total FROM transactions
        WHERE user_id = $1 AND kind = 'expense' AND ${day} LIKE $3 || '%' GROUP BY category ORDER BY total DESC LIMIT 4`,
      [userId, tz, month],
    ),
    many(
      `SELECT ${day} AS day, SUM(amount)::float8 AS total FROM transactions
        WHERE user_id = $1 AND kind = 'expense' AND occurred_at >= now() - interval '8 days' GROUP BY 1`,
      [userId, tz],
    ),
    one("SELECT amount::float8 AS amount FROM budgets WHERE user_id = $1 AND category IS NULL", [userId]),
  ]);
  if (!tot || (!tot.spent && !tot.income && !tot.prev)) return null;
  const byDay = new Map(week.map((w) => [String(w.day), Number(w.total)]));
  const days = Array.from({ length: 7 }, (_, i) => isoLocal(new Date(Date.now() - (6 - i) * 86_400_000), tz).slice(0, 10));
  return {
    type: "dinheiro",
    agent: "financeiro",
    month,
    spent: Number(tot.spent),
    income: Number(tot.income),
    prev: Number(tot.prev),
    limit: budget ? Number(budget.amount) : null,
    cats: cats.map((c) => ({ name: String(c.name), total: Number(c.total) })),
    week: days.map((d) => ({ day: d, total: byDay.get(d) ?? 0 })),
  };
}

/** Guarda os cartões da rodada como uma mensagem do assistente na conversa do app. Nunca derruba a resposta. */
export async function appCards(userId: string, tz: string, kinds: Iterable<string> | ("agenda" | "dinheiro")[], by: "tools" | "kinds" = "tools") {
  const wanted = by === "tools" ? cardKinds(kinds) : (kinds as ("agenda" | "dinheiro")[]);
  if (!wanted.length) return;
  const cards = await buildCards(userId, tz, wanted);
  if (cards.length) await saveAppMessage(userId, { role: "assistant", cards }).catch(() => {});
}
