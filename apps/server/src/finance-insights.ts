import { config } from "./config.js";
import { many } from "./db/pool.js";
import { brl } from "./agent/tools/finance.js";
import { listBills, todayIn } from "./bills.js";

/**
 * Visão de economia do Financeiro (painel > Finanças > Visão geral), sem IA: tudo sai dos lançamentos da própria
 * pessoa. Conta em centavos e devolve reais com 2 casas. O que entra:
 * - gastos que se repetem todo mês (assinaturas e fixos), achados pelo nome/estabelecimento e valor parecido;
 * - projeção do mês corrente (já gasto + fixos que ainda vão cair + ritmo dos gastos soltos);
 * - categorias que subiram contra a média dos 3 meses anteriores (no mês corrente, comparando até o mesmo dia);
 * - dicas concretas de onde cortar, com o valor estimado por mês (sem contar a mesma categoria duas vezes);
 * - essencial x flexível, dia da semana em que mais gasta e quanto sobrou nos últimos 6 meses.
 */

export interface InsightTx {
  kind: "expense" | "income";
  amount: number | string;
  category: string;
  description: string | null;
  merchant: string | null;
  /** AAAA-MM-DD no fuso da pessoa */
  day: string;
  installments: number | null;
}

export interface InsightBill {
  kind: "expense" | "income";
  description: string;
  amount: number | null;
  paid: boolean;
}

/** Contas da casa: dá para negociar, mas não é onde se corta primeiro. */
export const ESSENTIAL = new Set(["Moradia", "Mercado", "Saúde", "Educação", "Contas", "Transporte"]);
/** Não é gasto de consumo (é guardar dinheiro ou é entrada). */
const NOT_SPENDING = new Set(["Investimentos", "Salário"]);
/** Onde a dica de corte faz sentido. */
const CUTTABLE = new Set(["Alimentação", "Lazer", "Compras", "Viagem", "Assinaturas", "Outros", "Transporte"]);
const SMALL = 4000; // R$ 40,00
const WEEKDAYS = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"];

const cents = (v: number | string) => Math.round(Number(v) * 100);
const reais = (c: number) => Math.round(c) / 100;
const money = (c: number) => brl(reais(c));

export function shiftMonth(month: string, delta: number) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}
const daysOf = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** Nome que identifica a mesma cobrança em meses diferentes: sem acento, número nem pontuação, 3 primeiras palavras. */
export function recurringKey(t: Pick<InsightTx, "merchant" | "description" | "category">) {
  const raw = (t.merchant || t.description || t.category || "").toLowerCase();
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 3)
    .join(" ");
}

const label = (t: InsightTx) => (t.merchant || t.description || t.category).trim().slice(0, 60);

export interface Tip {
  id: string;
  icon: string;
  title: string;
  detail: string;
  /** economia estimada por mês, em reais */
  saving: number;
  category: string | null;
}

export function analyzeFinance(input: { month: string; today: string; txs: InsightTx[]; bills?: InsightBill[] }) {
  const { month, today } = input;
  const daysIn = daysOf(month);
  const isCurrent = today.slice(0, 7) === month;
  const elapsed = isCurrent ? Math.max(1, Number(today.slice(8, 10))) : daysIn;
  const prevMonths = [1, 2, 3].map((n) => shiftMonth(month, -n));
  const sixMonths = [5, 4, 3, 2, 1, 0].map((n) => shiftMonth(month, -n));

  const txs = input.txs.map((t) => ({ ...t, c: cents(t.amount), m: t.day.slice(0, 7), d: Number(t.day.slice(8, 10)), key: recurringKey(t) }));
  const spend = txs.filter((t) => t.kind === "expense" && !NOT_SPENDING.has(t.category));
  const inMonth = (m: string) => spend.filter((t) => t.m === m);
  const cur = inMonth(month);
  // meses anteriores que têm algum lançamento (sem histórico não dá para falar em média)
  const history = prevMonths.filter((m) => txs.some((t) => t.m === m));

  // ---------- gastos que se repetem ----------
  const window = [month, ...prevMonths];
  const byKey = new Map<string, typeof spend>();
  for (const t of spend) {
    if (!window.includes(t.m) || (t.installments ?? 1) > 1 || !t.key) continue;
    const list = byKey.get(t.key) ?? [];
    list.push(t);
    byKey.set(t.key, list);
  }
  const recurring: { key: string; name: string; category: string; monthly: number; yearly: number; months: number; lastMonth: string; chargedThisMonth: boolean; kind: "assinatura" | "fixo" }[] = [];
  for (const [key, list] of byKey) {
    const perMonth = new Map<string, { total: number; n: number }>();
    for (const t of list) {
      const p = perMonth.get(t.m) ?? { total: 0, n: 0 };
      p.total += t.c;
      p.n += 1;
      perMonth.set(t.m, p);
    }
    const months = [...perMonth.keys()].sort();
    const last = months[months.length - 1]!;
    // ainda ativa: apareceu neste mês ou no anterior
    if (last !== month && last !== prevMonths[0]) continue;
    const totals = [...perMonth.values()].map((p) => p.total);
    const category = list[list.length - 1]!.category;
    // conta da casa varia (luz, água); fora dela, só valor quase igual (uma ida por mês ao mesmo restaurante não é assinatura)
    const steady = Math.max(...totals) <= Math.min(...totals) * (ESSENTIAL.has(category) ? 1.35 : 1.05) && [...perMonth.values()].every((p) => p.n <= 2);
    const isSub = category === "Assinaturas";
    if (!(isSub || (months.length >= 2 && steady))) continue;
    const monthly = perMonth.get(last)!.total;
    if (monthly < 100) continue;
    const newest = list.reduce((a, b) => (a.day >= b.day ? a : b));
    recurring.push({
      key,
      name: label(newest),
      category,
      monthly: reais(monthly),
      yearly: reais(monthly * 12),
      months: months.length,
      lastMonth: last,
      chargedThisMonth: perMonth.has(month),
      kind: ESSENTIAL.has(category) ? "fixo" : "assinatura",
    });
  }
  recurring.sort((a, b) => b.monthly - a.monthly);
  const recurringKeys = new Set(recurring.map((r) => r.key));
  const isRecurring = (t: { key: string; installments: number | null }) => recurringKeys.has(t.key) || (t.installments ?? 1) > 1;

  // ---------- totais e sobra ----------
  const sumKind = (m: string, kind: "expense" | "income") => txs.filter((t) => t.m === m && t.kind === kind).reduce((a, t) => a + t.c, 0);
  const savings = sixMonths.map((m) => {
    const income = sumKind(m, "income");
    const expenses = sumKind(m, "expense");
    return { month: m, income: reais(income), expenses: reais(expenses), balance: reais(income - expenses), rate: income > 0 ? Math.round(((income - expenses) / income) * 100) : null };
  });
  const totals = savings[savings.length - 1]!;

  // ---------- ritmo do mês (acumulado por dia) ----------
  const cumulative = (m: string, upTo: number) => {
    const out: number[] = [];
    let acc = 0;
    const list = txs.filter((t) => t.m === m && t.kind === "expense");
    for (let d = 1; d <= upTo; d++) {
      acc += list.filter((t) => t.d === d).reduce((a, t) => a + t.c, 0);
      out.push(acc);
    }
    return out;
  };
  const curCum = cumulative(month, daysIn);
  const histCum = history.map((m) => {
    const c = cumulative(m, daysOf(m));
    return Array.from({ length: daysIn }, (_, i) => c[Math.min(i, c.length - 1)] ?? 0);
  });
  const avgCum = histCum.length ? Array.from({ length: daysIn }, (_, i) => histCum.reduce((a, c) => a + c[i]!, 0) / histCum.length) : null;
  const avgMonth = avgCum ? avgCum[daysIn - 1]! : null;
  const spentSoFar = isCurrent ? curCum[elapsed - 1]! : curCum[daysIn - 1]!;

  // ---------- projeção (só no mês corrente) ----------
  let projection: { expected: number; pendingFixed: number; pace: number; avgMonth: number | null; vsAvg: number | null } | null = null;
  if (isCurrent && elapsed < daysIn) {
    const pendingRecurring = recurring.filter((r) => !r.chargedThisMonth && r.lastMonth === prevMonths[0]);
    const pendingKeys = new Set(pendingRecurring.map((r) => r.key));
    let pendingFixed = pendingRecurring.reduce((a, r) => a + cents(r.monthly), 0);
    for (const b of input.bills ?? []) {
      if (b.kind !== "expense" || b.paid || b.amount == null) continue;
      // já está na conta: é uma cobrança que se repete e ainda não caiu, ou já foi lançada este mês
      const k = recurringKey({ merchant: null, description: b.description, category: "" });
      if (pendingKeys.has(k) || cur.some((t) => t.key === k)) continue;
      pendingFixed += cents(b.amount);
    }
    const looseSoFar = cur.filter((t) => t.d <= elapsed && !isRecurring(t)).reduce((a, t) => a + t.c, 0);
    // ritmo dos gastos soltos, puxado um pouco para o histórico (uma compra grande no começo do mês não vira tendência)
    const histLoose = history.length
      ? history.reduce((a, m) => a + inMonth(m).filter((t) => !isRecurring(t)).reduce((s, t) => s + t.c, 0) / daysOf(m), 0) / history.length
      : null;
    const pace = histLoose != null ? (looseSoFar + histLoose * 7) / (elapsed + 7) : looseSoFar / elapsed;
    const already = curCum[daysIn - 1]!; // inclui parcelas e lançamentos já marcados para os próximos dias
    const expected = already + pendingFixed + pace * (daysIn - elapsed);
    projection = { expected: reais(expected), pendingFixed: reais(pendingFixed), pace: reais(pace), avgMonth: avgMonth != null ? reais(avgMonth) : null, vsAvg: avgMonth != null ? reais(expected - avgMonth) : null };
  }

  const pace = {
    days: Array.from({ length: daysIn }, (_, i) => ({
      day: i + 1,
      actual: !isCurrent || i < elapsed ? reais(curCum[i]!) : null,
      avg: avgCum ? reais(avgCum[i]!) : null,
    })),
    today: isCurrent ? elapsed : null,
    expected: projection?.expected ?? null,
  };

  // ---------- o que mudou por categoria ----------
  // mês corrente: compara até o mesmo dia; mês fechado: o mês inteiro
  const catTotal = (m: string, upTo: number) => {
    const map = new Map<string, number>();
    for (const t of inMonth(m)) if (t.d <= upTo) map.set(t.category, (map.get(t.category) ?? 0) + t.c);
    return map;
  };
  const curCats = catTotal(month, isCurrent ? elapsed : 31);
  const histCats = history.map((m) => catTotal(m, isCurrent ? elapsed : 31));
  const cats = new Set([...curCats.keys(), ...histCats.flatMap((h) => [...h.keys()])]);
  const changes = history.length
    ? [...cats]
        .map((category) => {
          const now = curCats.get(category) ?? 0;
          const avg = histCats.reduce((a, h) => a + (h.get(category) ?? 0), 0) / history.length;
          return { category, current: reais(now), avg: reais(avg), delta: reais(now - avg), pct: avg > 0 ? Math.round(((now - avg) / avg) * 100) : null };
        })
        .filter((c) => Math.abs(c.delta) >= 1)
        .sort((a, b) => b.delta - a.delta)
    : [];

  // ---------- dicas de economia ----------
  const tips: Tip[] = [];
  const period = isCurrent ? `até o dia ${elapsed}` : "no mês";
  for (const c of changes) {
    const d = cents(c.delta);
    if (!CUTTABLE.has(c.category) || d < Math.max(3000, cents(c.avg) * 0.15)) continue;
    tips.push({
      id: `alta:${c.category}`,
      icon: "trend",
      title: `${c.category} acima da sua média`,
      detail: `${brl(c.current)} ${period}, contra ${brl(c.avg)} de média ${history.length === 1 ? "no mês anterior" : `nos ${history.length} meses anteriores`}. Voltar à média economiza ${brl(c.delta)}.`,
      saving: c.delta,
      category: c.category,
    });
  }
  const subs = recurring.filter((r) => r.kind === "assinatura");
  if (subs.length) {
    const top = subs[0]!;
    const total = subs.reduce((a, r) => a + cents(r.monthly), 0);
    tips.push({
      id: "assinaturas",
      icon: "repeat",
      title: subs.length === 1 ? `Revise ${top.name}` : `Revise suas ${subs.length} assinaturas`,
      detail:
        subs.length === 1
          ? `Custa ${brl(top.monthly)} por mês, ${brl(top.yearly)} no ano. Se usa pouco, cancelar economiza isso tudo.`
          : `Somam ${money(total)} por mês (${money(total * 12)} no ano). Cancelar a mais cara, ${top.name}, economiza ${brl(top.monthly)} por mês.`,
      saving: top.monthly,
      category: top.category,
    });
  }
  const loose = cur.filter((t) => CUTTABLE.has(t.category) && !isRecurring(t));
  const byPlace = new Map<string, typeof loose>();
  for (const t of loose) if (t.key) byPlace.set(t.key, [...(byPlace.get(t.key) ?? []), t]);
  const frequent = [...byPlace.values()].filter((l) => l.length >= 4).sort((a, b) => b.reduce((s, t) => s + t.c, 0) - a.reduce((s, t) => s + t.c, 0))[0];
  if (frequent) {
    const total = frequent.reduce((s, t) => s + t.c, 0);
    const ticket = total / frequent.length;
    const fewer = Math.max(1, Math.floor(frequent.length / 3));
    const name = label(frequent[0]!);
    tips.push({
      id: `frequente:${frequent[0]!.key}`,
      icon: "shop",
      title: `${name}: ${frequent.length} vezes ${isCurrent ? "este mês" : "no mês"}`,
      detail: `Foram ${money(total)}, ${money(ticket)} em média cada. ${fewer === 1 ? "Uma vez a menos economiza" : `${fewer} vezes a menos economizam`} ${money(ticket * fewer)}.`,
      saving: reais(ticket * fewer),
      category: frequent[0]!.category,
    });
  }
  const covered = new Set(tips.map((t) => t.category));
  const small = loose.filter((t) => t.c <= SMALL && !covered.has(t.category));
  const smallTotal = small.reduce((s, t) => s + t.c, 0);
  if (small.length >= 8 && smallTotal / 2 >= 2000) {
    tips.push({
      id: "pequenos",
      icon: "receipt",
      title: "Os gastos pequenos somam",
      detail: `${small.length} compras de até ${money(SMALL)} deram ${money(smallTotal)}. Segurar metade delas economiza ${money(smallTotal / 2)}.`,
      saving: reais(smallTotal / 2),
      category: null,
    });
  }
  tips.sort((a, b) => b.saving - a.saving);
  // total sem contar a mesma categoria duas vezes (fica a maior dica de cada uma)
  const best = new Map<string, number>();
  for (const t of tips) {
    const k = t.category ?? `__${t.id}`;
    best.set(k, Math.max(best.get(k) ?? 0, cents(t.saving)));
  }
  const potential = reais([...best.values()].reduce((a, b) => a + b, 0));

  // ---------- essencial x flexível e dia da semana ----------
  const essential = cur.filter((t) => ESSENTIAL.has(t.category)).reduce((a, t) => a + t.c, 0);
  const flexible = cur.filter((t) => !ESSENTIAL.has(t.category)).reduce((a, t) => a + t.c, 0);
  const flexCats = new Map<string, number>();
  for (const t of cur) if (!ESSENTIAL.has(t.category)) flexCats.set(t.category, (flexCats.get(t.category) ?? 0) + t.c);
  const wd = Array.from({ length: 7 }, () => 0);
  for (const t of spend) {
    if (!window.includes(t.m) || ESSENTIAL.has(t.category) || isRecurring(t)) continue;
    const js = new Date(`${t.day}T12:00:00Z`).getUTCDay();
    const i = (js + 6) % 7;
    wd[i] = (wd[i] ?? 0) + t.c;
  }
  const wdTotal = wd.reduce((a, b) => a + b, 0);
  const weekdays = wd.map((c, i) => ({ day: WEEKDAYS[i]!, total: reais(c), share: wdTotal ? Math.round((c / wdTotal) * 100) : 0 }));
  const topDay = wdTotal ? weekdays.reduce((a, b) => (b.total > a.total ? b : a)) : null;
  const weekendShare = wdTotal ? Math.round(((wd[5]! + wd[6]!) / wdTotal) * 100) : null;

  // ---------- frase de abertura ----------
  const headline: string[] = [];
  const incomeC = cents(totals.income);
  const expensesC = cents(totals.expenses);
  if (!cur.length && !incomeC) headline.push("Ainda não tem gasto lançado neste mês. No WhatsApp é só dizer \"gastei 32 no almoço\" ou mandar o comprovante.");
  else {
    if (projection?.vsAvg != null && Math.abs(projection.vsAvg) >= 1)
      headline.push(`No ritmo de agora, o mês fecha em ${brl(projection.expected)}, ${brl(Math.abs(projection.vsAvg))} ${projection.vsAvg > 0 ? "acima" : "abaixo"} da sua média.`);
    else if (projection) headline.push(`No ritmo de agora, o mês fecha em ${brl(projection.expected)}.`);
    else if (avgMonth != null && Math.abs(expensesC - avgMonth) >= 100)
      headline.push(`Você gastou ${money(Math.abs(expensesC - avgMonth))} ${expensesC > avgMonth ? "a mais" : "a menos"} que a sua média.`);
    if (incomeC > 0 && expensesC > incomeC) headline.push(`Até agora saiu ${money(expensesC - incomeC)} a mais do que entrou.`);
    else if (incomeC > 0 && totals.rate != null && totals.rate < 20) headline.push(`Para guardar 20% do que entrou faltam ${money(incomeC * 0.2 - (incomeC - expensesC))}.`);
    if (potential >= 1) headline.push(`Dá para economizar cerca de ${brl(potential)} por mês com as dicas abaixo.`);
  }

  return {
    month,
    isCurrent,
    daysIn,
    elapsed,
    spent: reais(spentSoFar),
    avgMonth: avgMonth != null ? reais(avgMonth) : null,
    historyMonths: history.length,
    totals,
    savings,
    projection,
    pace,
    changes,
    recurring: recurring.map((r) => ({ name: r.name, category: r.category, monthly: r.monthly, yearly: r.yearly, months: r.months, chargedThisMonth: r.chargedThisMonth, kind: r.kind })),
    recurringTotal: reais(recurring.reduce((a, r) => a + cents(r.monthly), 0)),
    tips: tips.slice(0, 5),
    potential,
    split: {
      essential: reais(essential),
      flexible: reais(flexible),
      flexibleTop: [...flexCats].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([category, c]) => ({ category, total: reais(c) })),
    },
    weekdays,
    topDay,
    weekendShare,
    headline: headline.join(" "),
  };
}

export type FinanceAnalysis = ReturnType<typeof analyzeFinance>;

/** Carrega 6 meses de lançamentos (até o mês escolhido) e as contas fixas, e analisa. */
export async function financeInsights(userId: string, month: string, tz = config.DEFAULT_TIMEZONE) {
  const months = [5, 4, 3, 2, 1, 0].map((n) => shiftMonth(month, -n));
  const txs = await many<InsightTx>(
    `SELECT kind, amount, category, description, merchant, to_char(occurred_at AT TIME ZONE $2, 'YYYY-MM-DD') AS day, installments
       FROM transactions WHERE user_id = $1 AND to_char(occurred_at AT TIME ZONE $2, 'YYYY-MM') = ANY($3::text[])`,
    [userId, tz, months],
  );
  const bills = (await listBills(userId, tz)).map((b) => ({ kind: b.kind, description: b.description, amount: b.amount, paid: b.status.paid }));
  return analyzeFinance({ month, today: todayIn(tz), txs, bills });
}
