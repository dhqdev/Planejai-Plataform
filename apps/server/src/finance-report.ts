import { barChart, budgetChart, donutChart, htmlToPdf } from "./charts.js";
import { config } from "./config.js";
import { many, one, query } from "./db/pool.js";
import { brl } from "./agent/tools/finance.js";
import { todayIn } from "./bills.js";
import { pdfFooter } from "./pdf.js";

/**
 * Relatório de finanças em PDF (Finanças > Relatório PDF e envio agendado no WhatsApp), sem IA:
 * os números vêm do banco, os textos explicativos são montados aqui e o layout vira A4 pelo mesmo
 * navegador do make_pdf (`htmlToPdf`). Mostra resumo, categorias, evolução de 6 meses, dia a dia,
 * maiores gastos, formas de pagamento, limites, contas fixas, cartões, dicas e todos os lançamentos.
 */

export interface ReportTx {
  day: string;
  kind: "expense" | "income";
  amount: number;
  category: string;
  description: string | null;
  merchant: string | null;
  card_name: string | null;
  installment: number | null;
  installments: number | null;
}

export interface ReportData {
  name: string;
  month: string;
  today: string;
  txs: ReportTx[];
  months: { month: string; income: number; expenses: number }[];
  prevByCategory: { category: string; total: number }[];
  budgets: { category: string | null; limit: number; spent: number }[];
  bills: { description: string; kind: "expense" | "income"; amount: number | null; due_day: number; paid: boolean }[];
  cards: { name: string; last4: string | null; limit: number | null; used: number; invoice: number; invoiceStatus: string | null; due: string | null; futureInstallments: number }[];
}

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
export const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]} de ${m.slice(0, 4)}`;
const short = (m: string) => (MONTHS[Number(m.slice(5)) - 1] ?? m).slice(0, 3);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const sum = (list: ReportTx[]) => r2(list.reduce((a, t) => a + t.amount, 0));
const nameOf = (t: ReportTx) => (t.description || t.merchant || t.category).trim();
export function shiftMonth(month: string, delta: number) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}
const daysOf = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

const CSS = `
@page{size:A4;margin:18mm 16mm 20mm}
*{box-sizing:border-box}
html,body{margin:0;background:#fff}
body{font-family:Inter,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#141414;font-size:10.5pt;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.bar{width:56px;height:7px;border-radius:4px;background:linear-gradient(90deg,#6510E0,#C42BEA)}
.cover{height:250mm;display:flex;flex-direction:column;justify-content:space-between;break-after:page}
.cover h1{font-size:34pt;line-height:1.1;letter-spacing:-.02em;margin:24mm 0 5mm;font-weight:700}
.cover .sub{font-size:14pt;color:#7A7A75;margin:0 0 12mm}
.cover .meta{font-size:10pt;color:#7A7A75;border-top:1px solid #ECECE8;padding-top:5mm;display:flex;justify-content:space-between}
.brand{font-weight:700;color:#6510E0}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:3mm;margin:4mm 0 5mm}
.kpi{border:1px solid #ECECE8;border-radius:3mm;padding:3.5mm 4mm;break-inside:avoid}
.kpi small{display:block;color:#7A7A75;font-size:8.5pt}
.kpi b{display:block;font-size:15pt;letter-spacing:-.01em;margin:1mm 0 .5mm;font-variant-numeric:tabular-nums}
.kpi span{font-size:8.5pt;color:#7A7A75}
.pos{color:#1F7A4D}.neg{color:#D12F45}
.toc ol{list-style:none;margin:0;padding:0}
.toc li{display:flex;gap:4mm;padding:2.2mm 0;border-bottom:1px solid #ECECE8;font-size:11pt}
.toc .n{color:#6510E0;font-weight:700;min-width:8mm}
section{margin:0 0 8mm}
section.page{break-before:page}
h2{font-size:15pt;line-height:1.25;margin:0 0 3mm;break-after:avoid;display:flex;gap:3mm;align-items:baseline}
h2 .n{color:#6510E0;font-size:11pt;font-weight:700}
h3{font-size:11.5pt;margin:5mm 0 2mm;break-after:avoid}
p{margin:0 0 3mm;orphans:3;widows:3}
.lead{font-size:11.5pt}
ul{margin:1mm 0 3mm;padding:0;list-style:none}
li{position:relative;padding-left:5mm;margin:1.4mm 0;break-inside:avoid}
li::before{content:"";position:absolute;left:0;top:.62em;width:2mm;height:2mm;border-radius:50%;background:#6510E0}
table{width:100%;border-collapse:collapse;margin:2mm 0 4mm;font-size:9pt}
thead{display:table-header-group}
th{text-align:left;background:#141414;color:#fff;padding:2mm 2.6mm;font-weight:600}
td{padding:1.9mm 2.6mm;border-bottom:1px solid #ECECE8;vertical-align:top}
td.r,th.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr{break-inside:avoid}
tr:nth-child(even) td{background:#FAFAF8}
tfoot{display:table-row-group}
tfoot td{font-weight:700;border-top:1.5px solid #141414;background:#fff !important}
.chart{break-inside:avoid;margin:2mm 0 4mm;border:1px solid #ECECE8;border-radius:4mm;overflow:hidden}
.chart svg{display:block;width:100%;height:auto;max-height:92mm}
.hl{border-left:3px solid #6510E0;background:#F6F3FE;border-radius:0 3mm 3mm 0;padding:3mm 4mm;margin:2mm 0 4mm;break-inside:avoid}
.hl p:last-child{margin:0}
.muted{color:#7A7A75}
.tag{display:inline-block;font-size:8pt;padding:.3mm 2mm;border-radius:9px;background:#F1F1EE;color:#555}
.tag.ok{background:#E6F4EC;color:#1F7A4D}.tag.bad{background:#FBE8EB;color:#D12F45}
.split{display:flex;height:5mm;border-radius:2.5mm;overflow:hidden;margin:2mm 0}
.split i{display:block}
`;

function table(cols: { label: string; right?: boolean }[], rows: (string | number)[][], foot?: (string | number)[]) {
  const th = cols.map((c) => `<th${c.right ? ' class="r"' : ""}>${esc(c.label)}</th>`).join("");
  const td = (r: (string | number)[]) => r.map((v, i) => `<td${cols[i]?.right ? ' class="r"' : ""}>${String(v)}</td>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${rows.map((r) => `<tr>${td(r)}</tr>`).join("")}</tbody>${foot ? `<tfoot><tr>${td(foot)}</tr></tfoot>` : ""}</table>`;
}
const chart = (svg: string) => `<div class="chart">${svg}</div>`;
const signed = (v: number) => (Math.abs(v) < 0.01 ? "–" : `<span class="${v > 0 ? "neg" : "pos"}">${v > 0 ? "+" : "−"}${brl(Math.abs(v))}</span>`);

/** Monta o HTML do relatório (puro: dá para testar sem banco nem navegador). */
export function buildFinanceReportHtml(d: ReportData) {
  const label = monthLabel(d.month);
  const isCurrent = d.today.slice(0, 7) === d.month;
  const exp = d.txs.filter((t) => t.kind === "expense");
  const inc = d.txs.filter((t) => t.kind === "income");
  const expenses = sum(exp);
  const income = sum(inc);
  const balance = r2(income - expenses);
  const prevMonth = d.months.find((m) => m.month === shiftMonth(d.month, -1));
  const history = d.months.filter((m) => m.month < d.month && (m.expenses || m.income));
  const histAvg = history.length ? r2(history.reduce((a, m) => a + m.expenses, 0) / history.length) : null;

  // categorias
  const catMap = new Map<string, { total: number; count: number }>();
  for (const t of exp) {
    const c = catMap.get(t.category) ?? { total: 0, count: 0 };
    c.total = r2(c.total + t.amount);
    c.count++;
    catMap.set(t.category, c);
  }
  const cats = [...catMap].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.total - a.total);
  const prevCat = new Map(d.prevByCategory.map((c) => [c.category, c.total]));
  const catDelta = cats.map((c) => ({ ...c, delta: prevCat.has(c.category) ? r2(c.total - prevCat.get(c.category)!) : null }));
  for (const [category, total] of prevCat) if (!catMap.has(category) && total > 0) catDelta.push({ category, total: 0, count: 0, delta: r2(-total) });
  const rising = catDelta.filter((c) => (c.delta ?? 0) >= 1).sort((a, b) => b.delta! - a.delta!);
  const falling = catDelta.filter((c) => (c.delta ?? 0) <= -1).sort((a, b) => a.delta! - b.delta!);

  // dia a dia e semanas
  const days = daysOf(d.month);
  const byDay = Array.from({ length: days }, (_, i) => sum(exp.filter((t) => Number(t.day.slice(8, 10)) === i + 1)));
  const topDayIdx = byDay.reduce((best, v, i) => (v > byDay[best]! ? i : best), 0);
  const weeks = [
    [1, 7],
    [8, 14],
    [15, 21],
    [22, days],
  ].map(([a, b]) => ({ label: `${a} a ${b}`, total: r2(byDay.slice(a! - 1, b).reduce((x, y) => x + y, 0)) }));
  const byWeekday = Array.from({ length: 7 }, () => 0);
  for (const t of exp) {
    const wd = new Date(`${t.day}T12:00:00Z`).getUTCDay();
    byWeekday[wd] = r2((byWeekday[wd] ?? 0) + t.amount);
  }
  const weekend = r2((byWeekday[0] ?? 0) + (byWeekday[6] ?? 0));

  // onde: maiores gastos e lugares
  const biggest = [...exp].sort((a, b) => b.amount - a.amount).slice(0, 10);
  const places = new Map<string, { total: number; count: number }>();
  for (const t of exp) {
    const k = (t.merchant || t.description || t.category).trim();
    const p = places.get(k) ?? { total: 0, count: 0 };
    p.total = r2(p.total + t.amount);
    p.count++;
    places.set(k, p);
  }
  const topPlaces = [...places].sort((a, b) => b[1].total - a[1].total).slice(0, 10);

  // forma de pagamento
  const byCard = new Map<string, number>();
  for (const t of exp) byCard.set(t.card_name ? `Cartão ${t.card_name}` : "Pix, dinheiro ou débito", r2((byCard.get(t.card_name ? `Cartão ${t.card_name}` : "Pix, dinheiro ou débito") ?? 0) + t.amount));
  const pays = [...byCard].sort((a, b) => b[1] - a[1]);
  const parcels = exp.filter((t) => (t.installments ?? 1) > 1);

  // ---------- textos ----------
  const resumo: string[] = [];
  if (!d.txs.length) resumo.push(`Não teve nenhum lançamento em ${label}. Quando você manda no WhatsApp o que gastou ou recebeu, eu organizo tudo aqui.`);
  else {
    resumo.push(`Em ${label}${isCurrent ? " (até hoje)" : ""} entraram <b>${brl(income)}</b> e saíram <b>${brl(expenses)}</b>.`);
    if (income > 0) resumo.push(balance >= 0 ? `Sobraram <b>${brl(balance)}</b>, ou seja, você guardou <b>${pct(balance, income)}%</b> do que entrou.` : `Faltaram <b>${brl(-balance)}</b>: os gastos passaram as entradas em ${pct(-balance, income)}%.`);
    else resumo.push("Nenhuma entrada foi lançada no mês, então não dá para saber quanto sobrou.");
    if (prevMonth && prevMonth.expenses > 0) {
      const diff = r2(expenses - prevMonth.expenses);
      if (Math.abs(diff) >= 1) resumo.push(`Comparado com ${MONTHS[Number(prevMonth.month.slice(5)) - 1]}, você gastou <b>${brl(Math.abs(diff))} ${diff > 0 ? "a mais" : "a menos"}</b> (${diff > 0 ? "+" : "−"}${Math.abs(pct(diff, prevMonth.expenses))}%).`);
    }
    if (cats[0]) resumo.push(`A maior parte foi para <b>${esc(cats[0].category)}</b>, com ${pct(cats[0].total, expenses)}% dos gastos.`);
  }

  const dicas: string[] = [];
  if (income > 0 && balance < 0) dicas.push(`O mês fechou no vermelho em ${brl(-balance)}. Vale olhar primeiro as categorias que mais subiram.`);
  else if (income > 0 && pct(balance, income) < 20) dicas.push(`Você guardou ${pct(balance, income)}% do que entrou. Uma meta comum é 20%, o que seria ${brl(r2(income * 0.2))} neste mês.`);
  else if (income > 0) dicas.push(`Bom mês: você guardou ${pct(balance, income)}% do que entrou.`);
  for (const c of rising.slice(0, 3)) dicas.push(`${c.category} subiu ${brl(c.delta!)} em relação ao mês anterior.`);
  for (const b of d.budgets.filter((b) => b.limit && b.spent > b.limit)) dicas.push(`O limite de ${b.category ?? "gasto total"} (${brl(b.limit)}) estourou em ${brl(r2(b.spent - b.limit))}.`);
  const smalls = exp.filter((t) => t.amount <= 40);
  if (smalls.length >= 8) dicas.push(`Foram ${smalls.length} gastos pequenos (até R$ 40) que somaram ${brl(sum(smalls))}. Eles passam despercebidos, mas pesam no fim do mês.`);
  const topPlace = topPlaces.find(([, p]) => p.count >= 4);
  if (topPlace) dicas.push(`${topPlace[0]} apareceu ${topPlace[1].count} vezes, somando ${brl(topPlace[1].total)}.`);
  const future = r2(d.cards.reduce((a, c) => a + c.futureInstallments, 0));
  if (future > 0) dicas.push(`Você já tem ${brl(future)} em parcelas de cartão para os próximos meses.`);
  if (weekend > 0 && expenses > 0 && pct(weekend, expenses) >= 40) dicas.push(`${pct(weekend, expenses)}% dos gastos foram no fim de semana.`);
  if (!dicas.length) dicas.push("Nada fora do normal neste mês.");

  // ---------- seções ----------
  const sections: { title: string; html: string; page?: boolean }[] = [];
  sections.push({
    title: "Resumo do mês",
    html: `<div class="kpis">
  <div class="kpi"><small>Entradas</small><b class="pos">${brl(income)}</b><span>${inc.length} ${inc.length === 1 ? "lançamento" : "lançamentos"}</span></div>
  <div class="kpi"><small>Saídas</small><b class="neg">${brl(expenses)}</b><span>${exp.length} ${exp.length === 1 ? "gasto" : "gastos"}</span></div>
  <div class="kpi"><small>Saldo</small><b class="${balance < 0 ? "neg" : ""}">${brl(balance)}</b><span>${income > 0 ? `${pct(balance, income)}% do que entrou` : "sem entradas"}</span></div>
  <div class="kpi"><small>Mês anterior</small><b>${prevMonth ? brl(prevMonth.expenses) : "–"}</b><span>gasto em ${prevMonth ? MONTHS[Number(prevMonth.month.slice(5)) - 1] : "–"}</span></div>
  <div class="kpi"><small>Maior gasto</small><b>${biggest[0] ? brl(biggest[0].amount) : "–"}</b><span>${biggest[0] ? esc(nameOf(biggest[0])).slice(0, 34) : "–"}</span></div>
  <div class="kpi"><small>Maior categoria</small><b>${cats[0] ? esc(cats[0].category) : "–"}</b><span>${cats[0] ? `${brl(cats[0].total)} · ${pct(cats[0].total, expenses)}%` : "–"}</span></div>
</div><p class="lead">${resumo.join(" ")}</p>`,
  });

  if (cats.length) {
    const explain = [`${cats
      .slice(0, 3)
      .map((c) => `${esc(c.category)} (${pct(c.total, expenses)}%)`)
      .join(", ")
      .replace(/, ([^,]*)$/, " e $1")} ${cats.length > 1 ? "foram as categorias que mais pesaram" : "foi a única categoria do mês"}.`];
    if (rising[0]) explain.push(`A que mais subiu foi ${esc(rising[0].category)} (+${brl(rising[0].delta!)}).`);
    if (falling[0]) explain.push(`A que mais caiu foi ${esc(falling[0].category)} (−${brl(-falling[0].delta!)}).`);
    sections.push({
      title: "Para onde foi o dinheiro",
      html: `<p>${explain.join(" ")}</p>${chart(donutChart("Gastos por categoria", label, cats.map((c) => ({ label: c.category, value: c.total }))))}
${table(
  [{ label: "Categoria" }, { label: "Gastos", right: true }, { label: "Valor", right: true }, { label: "% do total", right: true }, { label: "vs mês anterior", right: true }],
  catDelta.filter((c) => c.total > 0).map((c) => [esc(c.category), c.count, brl(c.total), `${pct(c.total, expenses)}%`, c.delta == null ? '<span class="muted">novo</span>' : signed(c.delta)]),
  ["Total", exp.length, brl(expenses), "100%", prevMonth?.expenses ? signed(r2(expenses - prevMonth.expenses)) : "–"],
)}`,
    });
  }

  if (d.months.some((m) => m.expenses || m.income)) {
    const best = [...d.months].filter((m) => m.income || m.expenses).sort((a, b) => b.income - b.expenses - (a.income - a.expenses))[0];
    const evo: string[] = [];
    if (histAvg != null) evo.push(`Nos ${history.length} ${history.length === 1 ? "mês anterior" : "meses anteriores"} você gastou em média ${brl(histAvg)} por mês. ${label.charAt(0).toUpperCase() + label.slice(1)} ficou ${expenses >= histAvg ? `${brl(r2(expenses - histAvg))} acima` : `${brl(r2(histAvg - expenses))} abaixo`} disso.`);
    if (best) evo.push(`O mês em que mais sobrou foi ${monthLabel(best.month)}, com ${brl(r2(best.income - best.expenses))}.`);
    sections.push({
      title: "Evolução dos últimos meses",
      html: `<p>${evo.join(" ")}</p>${chart(barChart("Gastos por mês", "últimos 6 meses", d.months.map((m) => ({ label: short(m.month), value: m.expenses })), { highlightLast: true }))}
${table(
  [{ label: "Mês" }, { label: "Entradas", right: true }, { label: "Saídas", right: true }, { label: "Saldo", right: true }, { label: "Guardou", right: true }],
  d.months.map((m) => [cap(monthLabel(m.month)), brl(m.income), brl(m.expenses), `<span class="${m.income - m.expenses < 0 ? "neg" : ""}">${brl(r2(m.income - m.expenses))}</span>`, m.income > 0 ? `${pct(r2(m.income - m.expenses), m.income)}%` : "–"]),
)}`,
    });
  }

  if (exp.length) {
    const wdTop = byWeekday.reduce((b, v, i) => (v > byWeekday[b]! ? i : b), 0);
    sections.push({
      title: "Dia a dia",
      html: `<p>O dia em que você mais gastou foi <b>${ddmm(`${d.month}-${String(topDayIdx + 1).padStart(2, "0")}`)}</b>, com ${brl(byDay[topDayIdx]!)}. Pelo dia da semana, <b>${WEEKDAYS[wdTop]}</b> concentrou ${pct(byWeekday[wdTop]!, expenses)}% dos gastos, e o fim de semana somou ${brl(weekend)} (${pct(weekend, expenses)}%).</p>
${chart(barChart("Gastos por dia", label, byDay.map((v, i) => ({ label: String(i + 1), value: v }))))}
<h3>Por semana do mês</h3>${table([{ label: "Dias" }, { label: "Gasto", right: true }, { label: "% do mês", right: true }], weeks.map((w) => [w.label, brl(w.total), `${pct(w.total, expenses)}%`]))}`,
    });

    sections.push({
      title: "Onde você mais gastou",
      page: true,
      html: `<h3>Os 10 maiores gastos</h3>${table(
        [{ label: "Data" }, { label: "Descrição" }, { label: "Categoria" }, { label: "Valor", right: true }],
        biggest.map((t) => [ddmm(t.day), esc(nameOf(t)), esc(t.category), brl(t.amount)]),
      )}
<h3>Lugares e descrições que mais aparecem</h3>${table(
        [{ label: "Onde" }, { label: "Vezes", right: true }, { label: "Total", right: true }, { label: "% do mês", right: true }],
        topPlaces.map(([k, p]) => [esc(k), p.count, brl(p.total), `${pct(p.total, expenses)}%`]),
      )}
<h3>Como você pagou</h3>
<div class="split">${pays.map(([, v], i) => `<i style="flex:${v};background:${["#141414", "#6510E0", "#C42BEA", "#8B5CF6", "#B5B5AF"][i % 5]}"></i>`).join("")}</div>
${table([{ label: "Forma" }, { label: "Valor", right: true }, { label: "% do mês", right: true }], pays.map(([k, v]) => [esc(k), brl(v), `${pct(v, expenses)}%`]))}${
        parcels.length ? `<p class="muted">${parcels.length} ${parcels.length === 1 ? "parcela de compra caiu" : "parcelas de compras caíram"} neste mês, somando ${brl(sum(parcels))}.</p>` : ""
      }`,
    });
  }

  if (d.budgets.length) {
    sections.push({
      title: "Limites do mês",
      html: `<p>${d.budgets.filter((b) => b.spent > b.limit).length ? `${d.budgets.filter((b) => b.spent > b.limit).length} de ${d.budgets.length} limites estouraram.` : "Nenhum limite estourou."}</p>${chart(budgetChart("Limites", label, d.budgets.map((b) => ({ label: b.category ?? "Total do mês", spent: b.spent, limit: b.limit }))))}
${table(
  [{ label: "Limite" }, { label: "Gasto", right: true }, { label: "Limite", right: true }, { label: "Usado", right: true }, { label: "Sobra", right: true }],
  d.budgets.map((b) => [esc(b.category ?? "Total do mês"), brl(b.spent), brl(b.limit), `<span class="${b.spent > b.limit ? "neg" : ""}">${pct(b.spent, b.limit)}%</span>`, brl(Math.max(0, r2(b.limit - b.spent)))]),
)}`,
    });
  }

  if (d.bills.length || d.cards.length) {
    const billsHtml = d.bills.length
      ? `<h3>Contas fixas</h3>${table(
          [{ label: "Conta" }, { label: "Dia", right: true }, { label: "Valor", right: true }, { label: "Situação" }],
          d.bills.map((b) => [esc(b.description), b.due_day, b.amount != null ? brl(b.amount) : "varia", b.paid ? `<span class="tag ok">${b.kind === "income" ? "recebida" : "paga"}</span>` : `<span class="tag">${b.kind === "income" ? "não marcada" : "não marcada como paga"}</span>`]),
          ["Total fixo do mês", "", brl(r2(d.bills.filter((b) => b.kind === "expense").reduce((a, b) => a + (b.amount ?? 0), 0))), ""],
        )}`
      : "";
    const cardsHtml = d.cards.length
      ? `<h3>Cartões de crédito</h3>${table(
          [{ label: "Cartão" }, { label: `Fatura de ${short(d.month)}`, right: true }, { label: "Situação" }, { label: "Limite usado", right: true }, { label: "Parcelas futuras", right: true }],
          d.cards.map((c) => [
            `${esc(c.name)}${c.last4 ? ` <span class="muted">·${esc(c.last4)}</span>` : ""}`,
            brl(c.invoice),
            c.invoiceStatus ? `<span class="tag ${c.invoiceStatus === "paga" ? "ok" : c.invoiceStatus === "atrasada" ? "bad" : ""}">${esc(c.invoiceStatus)}${c.due ? ` · vence ${ddmm(c.due)}` : ""}</span>` : "–",
            c.limit ? `${brl(c.used)} de ${brl(c.limit)}` : brl(c.used),
            brl(c.futureInstallments),
          ]),
        )}`
      : "";
    sections.push({ title: "Contas fixas e cartões", html: billsHtml + cardsHtml });
  }

  sections.push({ title: "O que eu observei", html: `<ul>${dicas.map((t) => `<li>${esc(t)}</li>`).join("")}</ul><div class="hl"><p>Quer mudar alguma coisa? No WhatsApp é só pedir: "cria um limite de 600 para delivery", "me lembra da fatura" ou "quanto gastei com mercado esse ano?".</p></div>` });

  if (d.txs.length) {
    const all = [...d.txs].sort((a, b) => a.day.localeCompare(b.day));
    const shown = all.slice(0, 500);
    sections.push({
      title: "Todos os lançamentos",
      page: true,
      html: `${table(
        [{ label: "Data" }, { label: "Descrição" }, { label: "Categoria" }, { label: "Como pagou" }, { label: "Valor", right: true }],
        shown.map((t) => [
          ddmm(t.day),
          esc(nameOf(t)),
          esc(t.category),
          t.card_name ? `Cartão ${esc(t.card_name)}${t.installments && t.installments > 1 ? ` ${t.installment}/${t.installments}` : ""}` : t.kind === "income" ? "–" : "Pix/dinheiro/débito",
          `<span class="${t.kind === "income" ? "pos" : ""}">${t.kind === "income" ? "+" : "−"}${brl(t.amount)}</span>`,
        ]),
        ["", "Saldo do mês", "", "", `<span class="${balance < 0 ? "neg" : "pos"}">${brl(balance)}</span>`],
      )}${all.length > shown.length ? `<p class="muted">Mostrando os primeiros ${shown.length} de ${all.length} lançamentos. A lista completa está em Finanças > Lançamentos.</p>` : ""}`,
    });
  }

  const date = new Date(`${d.today}T12:00:00Z`).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" });
  const cover = `<div class="cover"><div><div class="bar"></div><h1>Relatório financeiro<br>${esc(cap(label))}</h1><p class="sub">${esc(d.name)}${isCurrent ? " · parcial, até hoje" : ""}</p>
<div class="kpis"><div class="kpi"><small>Entradas</small><b class="pos">${brl(income)}</b></div><div class="kpi"><small>Saídas</small><b class="neg">${brl(expenses)}</b></div><div class="kpi"><small>Saldo</small><b class="${balance < 0 ? "neg" : ""}">${brl(balance)}</b></div></div>
<div class="toc"><ol>${sections.map((s, i) => `<li><span class="n">${i + 1}</span><span>${esc(s.title)}</span></li>`).join("")}</ol></div></div>
<div class="meta"><span>Gerado em ${esc(date)}</span><span class="brand">planejai</span></div></div>`;
  const body = sections
    .map((s, i) => `<section${s.page && i > 0 ? ' class="page"' : ""}><h2><span class="n">${String(i + 1).padStart(2, "0")}</span><span>${esc(s.title)}</span></h2>${s.html}</section>`)
    .join("");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório financeiro · ${esc(label)}</title><style>${CSS}</style></head><body>${cover}${body}</body></html>`;
}

/** Junta tudo do banco para um mês de uma pessoa. */
export async function loadReportData(userId: string, month: string, tz = config.DEFAULT_TIMEZONE): Promise<ReportData> {
  const user = await one<{ name: string | null; full_name: string | null }>("SELECT name, full_name FROM users WHERE id = $1", [userId]);
  const txs = await many<ReportTx>(
    `SELECT to_char(t.occurred_at AT TIME ZONE $2, 'YYYY-MM-DD') AS day, t.kind, t.amount::float AS amount, t.category, t.description, t.merchant,
            c.name AS card_name, t.installment, t.installments
       FROM transactions t LEFT JOIN cards c ON c.id = t.card_id
      WHERE t.user_id = $1 AND to_char(t.occurred_at AT TIME ZONE $2, 'YYYY-MM') = $3 ORDER BY t.occurred_at`,
    [userId, tz, month],
  );
  const list = [5, 4, 3, 2, 1, 0].map((n) => shiftMonth(month, -n));
  const sums = await many<{ month: string; income: number; expenses: number }>(
    `SELECT to_char(occurred_at AT TIME ZONE $2, 'YYYY-MM') AS month, COALESCE(SUM(amount) FILTER (WHERE kind='income'),0)::float AS income,
            COALESCE(SUM(amount) FILTER (WHERE kind='expense'),0)::float AS expenses
       FROM transactions WHERE user_id = $1 AND to_char(occurred_at AT TIME ZONE $2, 'YYYY-MM') = ANY($3::text[]) GROUP BY 1`,
    [userId, tz, list],
  );
  const months = list.map((m) => sums.find((s) => s.month === m) ?? { month: m, income: 0, expenses: 0 });
  const prevByCategory = await many<{ category: string; total: number }>(
    `SELECT category, SUM(amount)::float AS total FROM transactions WHERE user_id = $1 AND kind = 'expense' AND to_char(occurred_at AT TIME ZONE $2, 'YYYY-MM') = $3 GROUP BY 1`,
    [userId, tz, shiftMonth(month, -1)],
  );
  const { budgetStatus } = await import("./agent/tools/finance.js");
  const budgets = ((await budgetStatus(userId, tz, month)) as { category: string | null; limit: number; spent: number }[]).map((b) => ({ category: b.category, limit: Number(b.limit), spent: Number(b.spent) }));
  const bills = await many<{ description: string; kind: "expense" | "income"; amount: number | null; due_day: number; paid: boolean }>(
    `SELECT b.description, b.kind, b.amount::float AS amount, b.due_day,
            (b.last_paid_month >= $2 OR EXISTS (SELECT 1 FROM transactions t WHERE t.user_id = b.user_id AND t.external_ref = 'bill:' || b.id || ':' || $2)) AS paid
       FROM bills b WHERE b.user_id = $1 AND b.active ORDER BY b.due_day`,
    [userId, month],
  );
  const { listCards } = await import("./cards.js");
  const cards = (await listCards(userId, tz)).map((c) => {
    const inv = c.invoices.find((i) => i.month === month);
    return {
      name: c.name,
      last4: c.last4,
      limit: c.limit != null ? Number(c.limit) : null,
      used: c.used,
      invoice: inv?.total ?? 0,
      invoiceStatus: inv?.status ?? null,
      due: inv?.due ?? null,
      futureInstallments: r2(c.installments.reduce((a, i) => a + i.left_amount, 0)),
    };
  });
  return { name: user?.full_name || user?.name || "Suas finanças", month, today: todayIn(tz), txs, months, prevByCategory, budgets, bills, cards };
}

export const reportFileName = (month: string) => `Relatório financeiro - ${cap(monthLabel(month))}.pdf`;

export async function renderFinanceReport(userId: string, month: string, tz = config.DEFAULT_TIMEZONE) {
  const data = await loadReportData(userId, month, tz);
  return htmlToPdf(buildFinanceReportHtml(data), pdfFooter(`Relatório financeiro · ${monthLabel(month)}`));
}

// ---------- envio agendado ----------

export async function getReportSchedule(userId: string) {
  return one<{ day: number; last_sent_on: string | null }>("SELECT day, to_char(last_sent_on, 'YYYY-MM-DD') AS last_sent_on FROM finance_report_schedules WHERE user_id = $1", [userId]);
}

/** day null = desliga. */
export async function setReportSchedule(userId: string, day: number | null) {
  if (day == null) {
    await query("DELETE FROM finance_report_schedules WHERE user_id = $1", [userId]);
    return null;
  }
  const d = Math.floor(Number(day));
  if (!(d >= 1 && d <= 31)) throw new Error("Escolha um dia entre 1 e 31");
  await query(
    `INSERT INTO finance_report_schedules (user_id, day) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET day = $2`,
    [userId, d],
  );
  return getReportSchedule(userId);
}

/** Dia do envio neste mês: 31 em fevereiro vira o último dia. */
export const isSendDay = (day: number, today: string) => Number(today.slice(8, 10)) === Math.min(day, daysOf(today.slice(0, 7)));

/** Mês que o envio agendado cobre: sempre o anterior, completo. */
export const reportMonthFor = (today: string) => shiftMonth(today.slice(0, 7), -1);

/** Gera, guarda em Documentos e manda no WhatsApp. */
export async function sendFinanceReport(userId: string, month: string, tz = config.DEFAULT_TIMEZONE, intro?: string) {
  const pdf = await renderFinanceReport(userId, month, tz);
  const fileName = reportFileName(month);
  const { saveDocument } = await import("./documents.js");
  await saveDocument({ userId, name: fileName, mimetype: "application/pdf", data: pdf, folder: "Feitos pelo assistente", source: "assistente" }).catch(() => null);
  const { notifyUser } = await import("./social.js");
  await notifyUser(userId, intro ?? `Seu relatório financeiro de ${monthLabel(month)} está aqui 📊 Tem o resumo, os gráficos, as tabelas e todos os lançamentos.`, {
    base64: pdf.toString("base64"),
    mimetype: "application/pdf",
    kind: "document",
    fileName,
  });
  return { fileName, bytes: pdf.length };
}

/** Rodada das 9h (finance.daily): manda o relatório de quem marcou o dia de hoje. */
export async function sendScheduledReports(log?: { info: (...a: any[]) => void; error: (...a: any[]) => void }) {
  const rows = await many<{ user_id: string; day: number; last_sent_on: string | null; timezone: string | null }>(
    `SELECT s.user_id, s.day, to_char(s.last_sent_on, 'YYYY-MM-DD') AS last_sent_on, u.timezone
       FROM finance_report_schedules s JOIN users u ON u.id = s.user_id WHERE u.status = 'active'`,
  );
  let sent = 0;
  for (const r of rows) {
    const tz = r.timezone ?? config.DEFAULT_TIMEZONE;
    const today = todayIn(tz);
    if (r.last_sent_on === today || !isSendDay(r.day, today)) continue;
    const month = reportMonthFor(today);
    try {
      await query("UPDATE finance_report_schedules SET last_sent_on = $2 WHERE user_id = $1", [r.user_id, today]);
      await sendFinanceReport(r.user_id, month, tz, `Chegou o seu relatório financeiro de ${monthLabel(month)} 📊 Como combinado, todo dia ${r.day}. Tem o resumo do mês, gráficos, tabelas e o que eu observei.`);
      sent++;
    } catch (err) {
      log?.error({ err, userId: r.user_id }, "relatório financeiro agendado falhou");
    }
  }
  if (sent) log?.info({ sent }, "relatórios financeiros enviados");
  return sent;
}
