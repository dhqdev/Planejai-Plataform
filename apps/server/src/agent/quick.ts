import { many, one } from "../db/pool.js";
import { isConnected } from "../integrations/registry.js";
import { asPerson } from "../integrations/person.js";
import { reminderOccurrences } from "../reminders.js";
import { isoLocal, parseLocalDateTime } from "../time.js";
import { brl } from "./tools/finance.js";

/**
 * Atalhos sem IA: os pedidos mais comuns saem direto do banco, sem chamar o CTO.
 * Só pega frase curta e inequívoca; qualquer dúvida devolve null e o time responde como sempre.
 */
export type QuickIntent = { kind: "gasto_mes" } | { kind: "agenda"; day: 0 | 1 } | { kind: "apaga_ultimo"; noun: boolean };

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\p{Extended_Pictographic}‍️]/gu, "")
    .replace(/[?!.,;:~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const OPEN = "(?:(?:e |ei |oi |ola |fala )?(?:juvenal |planejai )?)";
const MES = "(?:(?:n?es[st]e|no|do|nes) mes(?: atual)?|(?:n?es[st]e|no) mes ate agora|ate agora(?: (?:n?es[st]e|no) mes)?)";
const GASTO = new RegExp(
  `^${OPEN}(?:quanto (?:que )?(?:eu )?(?:ja )?gastei|quanto (?:eu )?(?:ja )?(?:gastei|torrei)|qual (?:foi |e )?(?:o )?(?:meu |o )?(?:total de |total dos )?gastos?|quanto (?:deu|foi|ta|esta) (?:os |meus |o total dos )?(?:meus )?gastos?|meus gastos|total (?:de|dos) gastos) ${MES}$`,
);
const AGENDA = new RegExp(
  `^${OPEN}(?:o que|oq|que|qual(?: e)?(?: a)?) (?:eu )?(?:tenho|tem|vou ter)(?: (?:marcado|agendado|de compromisso|na agenda))?(?: (?:pra|para))? (hoje|amanha)$|^${OPEN}(?:minha agenda|agenda|meus compromissos|compromissos)(?: (?:de|pra|para|do dia de))? (hoje|amanha)$|^${OPEN}(?:tenho|tem) (?:algo|alguma coisa|algum compromisso|compromisso)(?: marcado)?(?: (?:pra|para))? (hoje|amanha)$`,
);
const APAGA = /^(?:apaga|apague|exclui|exclua|deleta|delete|remove|remova|tira|cancela)(?: (?:o|esse|aquele))? ultimo( (?:gasto|lancamento|registro|que (?:eu )?(?:anotei|lancei|mandei)))?(?: (?:pra mim|por favor|pf|pfv))?$/;

export function matchQuick(raw: string): QuickIntent | null {
  const t = norm(raw);
  if (!t || t.length > 70) return null;
  if (GASTO.test(t)) return { kind: "gasto_mes" };
  const a = AGENDA.exec(t);
  if (a) return { kind: "agenda", day: (a[1] ?? a[2] ?? a[3]) === "amanha" ? 1 : 0 };
  const d = APAGA.exec(t);
  if (d) return { kind: "apaga_ultimo", noun: Boolean(d[1]) };
  return null;
}

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const money = (n: unknown) => brl(Math.round(Number(n ?? 0) * 100) / 100);
const hm = (d: Date, tz: string) => {
  const [h, m] = isoLocal(d, tz).slice(11, 16).split(":");
  return m === "00" ? `${Number(h)}h` : `${Number(h)}h${m}`;
};

/** Responde o atalho; null = deixa para o time (ex.: Google Agenda conectado, parcela, coisa mais nova que o lançamento). */
export async function quickAnswer(user: { id: string; phone: string }, owner: boolean, intent: QuickIntent, tz: string): Promise<{ text: string; data: Record<string, unknown> } | null> {
  const today = isoLocal(new Date(), tz).slice(0, 10);
  if (intent.kind === "gasto_mes") {
    const month = today.slice(0, 7);
    const where = "user_id = $1 AND kind = 'expense' AND to_char(occurred_at AT TIME ZONE $2, 'YYYY-MM') = $3";
    const total = await one(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*)::int AS n FROM transactions WHERE ${where}`, [user.id, tz, month]);
    const top = await many(`SELECT category, SUM(amount) AS total FROM transactions WHERE ${where} GROUP BY category ORDER BY total DESC LIMIT 3`, [user.id, tz, month]);
    const name = MONTHS[Number(month.slice(5)) - 1];
    if (!total?.n) return { text: `Ainda não tem nenhum gasto anotado em ${name}. Quando gastar, é só me mandar 💸`, data: { mes: month, total: 0 } };
    const parts = top.map((c) => `${c.category} (${money(c.total)})`);
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} e ${parts.at(-1)}` : parts[0];
    const text =
      `Em ${name} você já gastou ${money(total.total)} 💸\n` +
      (top.length > 1 ? `O que mais pesou foi ${list}.` : `Tudo em ${list}.`) +
      "\nQuer ver por categoria ou um gráfico?";
    return { text, data: { mes: month, total: money(total.total), lancamentos: total.n } };
  }

  if (intent.kind === "agenda") {
    // quem tem Google Agenda conectado: o time olha lá também (o atalho só conhece os lembretes)
    if (await asPerson({ userId: user.id, owner }, () => isConnected("google")).catch(() => true)) return null;
    const dayStart = parseLocalDateTime(`${today}T00:00`, tz);
    const from = intent.day === 0 ? new Date() : new Date(dayStart.getTime() + 86_400_000);
    const to = new Date(dayStart.getTime() + (intent.day + 1) * 86_400_000);
    const occ = (await reminderOccurrences(from, to, user.id))
      .filter((o) => new Date(o.start) >= from && new Date(o.start) < to)
      .sort((a, b) => a.start.localeCompare(b.start));
    const msgs = await many(
      "SELECT name, phone, send_at FROM direct_messages WHERE user_id = $1 AND status = 'scheduled' AND send_at >= $2 AND send_at < $3 ORDER BY send_at LIMIT 10",
      [user.id, from, to],
    );
    const label = intent.day === 0 ? "Hoje" : "Amanhã";
    const lines = [
      ...occ.slice(0, 12).map((o) => ({ at: o.start, line: `${hm(new Date(o.start), tz)} ${String(o.title).replace(/\s*\(criado pelo painel\)$/, "").slice(0, 80)}` })),
      ...msgs.map((m) => ({ at: new Date(m.send_at).toISOString(), line: `${hm(new Date(m.send_at), tz)} sai sua mensagem para ${m.name || `+${m.phone}`}` })),
    ]
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((l) => l.line);
    if (!lines.length) return { text: intent.day === 0 ? "Hoje não tem mais nada marcado 🙌" : "Amanhã está livre, nada marcado 🙌", data: { dia: label, itens: 0 } };
    const text = `${label} você tem ${lines.length === 1 ? "isso" : `${lines.length} coisas`} 📅\n${lines.join("\n")}`;
    return { text, data: { dia: label, itens: lines.length } };
  }

  // "apaga o último": só o lançamento mais recente, anotado há pouco, que não é parcela, e se nada mais novo foi criado
  const last = await one(
    "SELECT id, description, merchant, category, amount, kind, installments, created_at FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
    [user.id],
  );
  if (!last || (last.installments ?? 1) > 1) return null;
  const age = Date.now() - new Date(last.created_at).getTime();
  if (age > (intent.noun ? 24 : 2) * 3_600_000) return null;
  if (!intent.noun) {
    // sem dizer o quê: se a última coisa criada foi um lembrete ou recado, não é com o atalho
    const newer = await one(
      `SELECT 1 FROM reminders WHERE user_id = $1 AND created_at > $2
        UNION ALL SELECT 1 FROM direct_messages WHERE user_id = $1 AND created_at > $2 LIMIT 1`,
      [user.id, last.created_at],
    );
    if (newer) return null;
  }
  const gone = await one("DELETE FROM transactions WHERE user_id = $1 AND id = $2 RETURNING id", [user.id, last.id]);
  if (!gone) return null;
  const what = last.description || last.merchant || last.category;
  const text = `Pronto, apaguei ${last.kind === "income" ? "a entrada" : "o gasto"} ${what} de ${money(last.amount)} 🗑️`;
  return { text, data: { apagado: last.id, valor: money(last.amount), descricao: what } };
}
