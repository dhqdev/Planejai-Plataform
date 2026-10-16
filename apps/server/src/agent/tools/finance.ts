import { config } from "../../config.js";
import { emitEvent } from "../../events.js";
import { randomUUID } from "node:crypto";
import { many, one, query } from "../../db/pool.js";
import { getCredentials } from "../../integrations/registry.js";
import { canView } from "../../sharing.js";
import { findContact } from "../../social.js";
import { parseLocalDateTime } from "../../time.js";
import { barChart, budgetChart, donutChart, svgToPng } from "../../charts.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";
import { autoCategory, ensureCategories, FALLBACK, learnCategory, plain, resolveCategory } from "../../categories.js";
import { CARD_USED } from "../claims.js";
import { addMonths, cardInText, invoiceDates, invoiceMonthFor, listCards, localDate, monthName, placeOnCard, resolveCard, shiftDate, type Card } from "../../cards.js";

export { CATEGORIES, guessCategory } from "../../categories.js";

/** Converte "R$ 1.234,56", "8,20", "1234.5", 12 em número com 2 casas (centavos exatos). */
export function parseAmount(v: unknown): number {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("Valor inválido");
    return Math.round(Math.abs(v) * 100) / 100;
  }
  let s = String(v ?? "").replace(/[R$\s]/gi, "").replace(/^-/, "");
  if (!s) throw new Error("Valor vazio");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", "."); // 1.234,56
  else if (lastDot > lastComma && lastComma >= 0) s = s.replace(/,/g, ""); // 1,234.56
  else if (lastDot >= 0 && /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ""); // 1.234 = mil duzentos...
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Valor inválido: ${v}`);
  return Math.round(Math.abs(n) * 100) / 100;
}

export const brl = (n: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n).replace(/\u00a0/g, " ");
const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;

/** Divide um total em N parcelas sem perder centavos (a diferença vai na primeira). */
export function splitInstallments(total: number, n: number): number[] {
  const totalCents = Math.round(total * 100);
  const base = Math.floor(totalCents / n);
  const parts = Array.from({ length: n }, () => base);
  parts[0]! += totalCents - base * n;
  return parts.map((c) => c / 100);
}

/** Avaliador aritmético seguro (sem eval): + - * / % ^ parênteses, vírgula decimal e "x" como vezes. */
export function calc(expression: string): number {
  const src = expression.replace(/(\d),(\d)/g, "$1.$2").replace(/[x×]/gi, "*").replace(/÷/g, "/").replace(/R\$/gi, "");
  let i = 0;
  const peek = () => src[i];
  const skip = () => {
    while (src[i] === " ") i++;
  };
  function num(): number {
    skip();
    if (peek() === "(") {
      i++;
      const v = expr();
      skip();
      if (src[i++] !== ")") throw new Error("parêntese faltando");
      return v;
    }
    if (peek() === "-") {
      i++;
      return -num();
    }
    const m = src.slice(i).match(/^\d+(\.\d+)?/);
    if (!m) throw new Error(`não entendi a expressão perto de "${src.slice(i, i + 8)}"`);
    i += m[0].length;
    skip();
    if (peek() === "%") {
      i++;
      return Number(m[0]) / 100;
    }
    return Number(m[0]);
  }
  function pow(): number {
    const b = num();
    skip();
    if (peek() === "^") {
      i++;
      return b ** pow();
    }
    return b;
  }
  function term(): number {
    let v = pow();
    for (;;) {
      skip();
      const op = peek();
      if (op !== "*" && op !== "/") return v;
      i++;
      const r = pow();
      if (op === "/" && r === 0) throw new Error("divisão por zero");
      v = op === "*" ? v * r : v / r;
    }
  }
  function expr(): number {
    let v = term();
    for (;;) {
      skip();
      const op = peek();
      if (op !== "+" && op !== "-") return v;
      i++;
      v = op === "+" ? v + term() : v - term();
    }
  }
  const v = expr();
  skip();
  if (i < src.length) throw new Error(`sobrou "${src.slice(i)}" na expressão`);
  return v;
}

export const calculate = defineTool<{ expression: string }>({
  name: "calculate",
  description:
    "Calculadora exata para qualquer conta (nunca de cabeça). Ex.: (89,90 + 45,50) / 3, 1200 * 12%, 2500 * (1 + 1,5%)^12.",
  parameters: obj({ expression: { type: "string" } }, ["expression"]),
  async run(args) {
    const v = calc(args.expression);
    return { expression: args.expression, result: Math.round(v * 1e6) / 1e6, result_2_decimals: Math.round(v * 100) / 100, formatted_brl: brl(Math.round(v * 100) / 100) };
  },
});

async function monthTotals(userId: string, timezone: string, when: Date, category: string) {
  const r = await one(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE kind='expense'),0) AS expenses,
            COALESCE(SUM(amount) FILTER (WHERE kind='income'),0) AS income,
            COALESCE(SUM(amount) FILTER (WHERE kind='expense' AND category=$4),0) AS category_total
       FROM transactions WHERE user_id = $1
        AND date_trunc('month', occurred_at AT TIME ZONE $2) = date_trunc('month', $3::timestamptz AT TIME ZONE $2)`,
    [userId, timezone, when, category],
  );
  return {
    month_expenses: brl(cents(r?.expenses)),
    month_income: brl(cents(r?.income)),
    month_category_total: brl(cents(r?.category_total)),
  };
}


// ---------- Limites de gastos ----------

const monthKey = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).format(d);

/** Quanto foi gasto de cada limite no mês (category null = total). */
export async function budgetStatus(userId: string, tz: string, month?: string) {
  const m = month ?? monthKey(new Date(), tz);
  return many(
    `SELECT b.id, b.category, b.amount::float AS limit, b.alerted_month, b.alerted_level,
            COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.user_id = b.user_id AND t.kind = 'expense'
               AND (b.category IS NULL OR t.category = b.category) AND to_char(t.occurred_at AT TIME ZONE $2, 'YYYY-MM') = $3), 0)::float AS spent
       FROM budgets b WHERE b.user_id = $1 ORDER BY b.category NULLS FIRST`,
    [userId, tz, m],
  );
}

/** Depois de um gasto: avisa uma vez ao passar de 80% e uma vez ao estourar, por mês. */
async function budgetAlerts(userId: string, tz: string, category: string, when: Date) {
  const m = monthKey(when, tz);
  const rows = (await budgetStatus(userId, tz, m)).filter((b) => b.category === null || b.category === category);
  const alerts: string[] = [];
  for (const b of rows) {
    const pct = b.spent / b.limit;
    const level = pct >= 1 ? 100 : pct >= 0.8 ? 80 : 0;
    const prev = b.alerted_month === m ? b.alerted_level : 0;
    if (level > prev) {
      await query("UPDATE budgets SET alerted_month = $2, alerted_level = $3 WHERE id = $1", [b.id, m, level]);
      const name = b.category ?? "gastos do mês";
      alerts.push(
        level === 100
          ? `Estourou o limite de ${name}: ${brl(cents(b.spent))} de ${brl(b.limit)} (${Math.round(pct * 100)}%).`
          : `Já foi ${Math.round(pct * 100)}% do limite de ${name}: ${brl(cents(b.spent))} de ${brl(b.limit)}. Restam ${brl(cents(b.limit - b.spent))}.`,
      );
    }
  }
  return alerts;
}

export const setBudget = defineTool<{ category?: string; amount: number | string; remove?: boolean }>({
  name: "set_budget",
  description:
    "Cria, muda ou remove limite mensal de gastos (sem categoria = total do mês). O sistema avisa sozinho em 80% e ao estourar.",
  parameters: obj(
    {
      category: { type: "string", description: "Uma categoria dela; vazio ou Total = total do mês" },
      amount: { type: "number", description: "Reais por mês" },
      remove: { type: "boolean" },
    },
    ["amount"],
  ),
  async run(args, ctx) {
    let category: string | null = null;
    if (args.category?.trim() && !/^total/i.test(args.category.trim())) {
      const found = await resolveCategory(ctx.user.id, args.category);
      if (!found) return { ok: false, error: `Ela não tem a categoria "${args.category}". Use uma destas: ${(await ensureCategories(ctx.user.id)).map((c) => c.name).join(", ")}` };
      category = found.name;
    }
    if (args.remove) {
      await query("DELETE FROM budgets WHERE user_id = $1 AND COALESCE(category, '*') = COALESCE($2::text, '*')", [ctx.user.id, category]);
      return { ok: true, removed: category ?? "Total" };
    }
    const amount = parseAmount(args.amount);
    if (amount <= 0) return { ok: false, error: "Limite precisa ser maior que zero" };
    await query(
      `INSERT INTO budgets (user_id, category, amount) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, COALESCE(category, '*')) DO UPDATE SET amount = $3, alerted_level = 0, alerted_month = NULL`,
      [ctx.user.id, category, amount],
    );
    const st = (await budgetStatus(ctx.user.id, ctx.timezone)).find((b) => b.category === category);
    return { ok: true, category: category ?? "Total", limit: brl(amount), spent_this_month: brl(cents(st?.spent ?? 0)), used: `${Math.round(((st?.spent ?? 0) / amount) * 100)}%` };
  },
});

export const budgetStatusTool = defineTool<Record<string, never>>({
  name: "budget_status",
  description: "Mostra os limites de gastos da pessoa e quanto já usou de cada um neste mês.",
  parameters: obj({}),
  async run(_a, ctx) {
    const rows = await budgetStatus(ctx.user.id, ctx.timezone);
    if (!rows.length) return { budgets: [], note: "Nenhum limite criado ainda." };
    return { budgets: rows.map((b) => ({ category: b.category ?? "Total", limit: brl(b.limit), spent: brl(cents(b.spent)), used: `${Math.round((b.spent / b.limit) * 100)}%`, left: brl(cents(Math.max(0, b.limit - b.spent))) })) };
  },
});

// ---------- Gráficos ----------

const MONTHS_PT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const monthLabel = (m: string) => `${MONTHS_PT[Number(m.slice(5)) - 1]}/${m.slice(2, 4)}`;

export const makeChart = defineTool<{ kind: "categorias" | "meses" | "dias" | "limites"; month?: string; category?: string; months?: number }>({
  name: "make_chart",
  description:
    "Gráfico dos gastos (imagem, sem custo): categorias do mês, meses, dias do mês ou limites. Devolve media_id para [[media:ID]].",
  parameters: obj(
    {
      kind: { type: "string", enum: ["categorias", "meses", "dias", "limites"] },
      month: { type: "string", description: "AAAA-MM; padrão atual" },
      category: { type: "string", description: "Filtra meses/dias" },
      months: { type: "number", description: "Padrão 6" },
    },
    ["kind"],
  ),
  async run(args, ctx) {
    const tz = ctx.timezone;
    const month = /^\d{4}-\d{2}$/.test(args.month ?? "") ? args.month! : monthKey(new Date(), tz);
    const cat = args.category ? ((await resolveCategory(ctx.user.id, args.category))?.name ?? null) : null;
    const name = ctx.user.name ? ` de ${ctx.user.name.split(" ")[0]}` : "";
    let svg: string;
    let summary: unknown;
    if (args.kind === "categorias") {
      const rows = await many(
        `SELECT category AS label, SUM(amount)::float AS value FROM transactions WHERE user_id = $1 AND kind = 'expense'
          AND to_char(occurred_at AT TIME ZONE $2, 'YYYY-MM') = $3 GROUP BY 1 ORDER BY 2 DESC`,
        [ctx.user.id, tz, month],
      );
      if (!rows.length) return { ok: false, error: `Sem gastos em ${monthLabel(month)} para desenhar.` };
      svg = donutChart(`Gastos${name}`, `por categoria em ${monthLabel(month)}`, rows as any);
      summary = rows.slice(0, 5).map((r) => `${r.label}: ${brl(cents(r.value))}`);
    } else if (args.kind === "meses") {
      const n = Math.min(Math.max(2, Math.floor(args.months ?? 6)), 12);
      const rows = await many(
        `SELECT to_char(m, 'YYYY-MM') AS month, COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.user_id = $1 AND t.kind = 'expense'
            AND ($4::text IS NULL OR t.category = $4) AND to_char(t.occurred_at AT TIME ZONE $2, 'YYYY-MM') = to_char(m, 'YYYY-MM')), 0)::float AS value
           FROM generate_series(to_date($3, 'YYYY-MM') - make_interval(months => $5 - 1), to_date($3, 'YYYY-MM'), interval '1 month') m`,
        [ctx.user.id, tz, month, cat, n],
      );
      const budget = (await budgetStatus(ctx.user.id, tz, month)).find((b) => b.category === cat);
      svg = barChart(`Gastos${cat ? ` com ${cat}` : ""}${name}`, `últimos ${n} meses`, rows.map((r) => ({ label: monthLabel(r.month), value: r.value })), { highlightLast: true, limit: budget?.limit });
      summary = rows.map((r) => `${monthLabel(r.month)}: ${brl(cents(r.value))}`);
    } else if (args.kind === "dias") {
      const rows = await many(
        `SELECT to_char(d, 'DD') AS day, COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.user_id = $1 AND t.kind = 'expense'
            AND ($4::text IS NULL OR t.category = $4) AND (t.occurred_at AT TIME ZONE $2)::date = d::date), 0)::float AS value
           FROM generate_series(to_date($3, 'YYYY-MM'), LEAST((to_date($3, 'YYYY-MM') + interval '1 month' - interval '1 day')::date, (now() AT TIME ZONE $2)::date), interval '1 day') d`,
        [ctx.user.id, tz, month, cat],
      );
      if (!rows.some((r) => r.value > 0)) return { ok: false, error: `Sem gastos em ${monthLabel(month)} para desenhar.` };
      svg = barChart(`Gasto por dia${cat ? ` com ${cat}` : ""}`, monthLabel(month), rows.map((r) => ({ label: r.day, value: r.value })));
      summary = { total: brl(cents(rows.reduce((a, r) => a + r.value, 0))) };
    } else {
      const rows = await budgetStatus(ctx.user.id, tz, month);
      if (!rows.length) return { ok: false, error: "Nenhum limite criado ainda. Use set_budget primeiro." };
      svg = budgetChart("Limites do mês", monthLabel(month), rows.map((b) => ({ label: b.category ?? "Total do mês", spent: b.spent, limit: b.limit })));
      summary = rows.map((b) => `${b.category ?? "Total"}: ${Math.round((b.spent / b.limit) * 100)}%`);
    }
    const base64 = await svgToPng(svg);
    const id = ctx.outbox.addMedia({ base64, mimetype: "image/png", caption: undefined, fileName: "grafico.png" });
    return { media_id: id, how_to_send: `Coloque [[media:${id}]] na resposta, com uma frase curta sobre o que o gráfico mostra.`, data: summary };
  },
});


/**
 * De quem são as finanças consultadas: da própria pessoa ou de um contato que compartilhou com ela (só leitura).
 * Devolve o id ou um erro pronto para o modelo.
 */
async function financeOwner(ctx: { user: { id: string } }, ofContact?: string): Promise<{ id: string; name?: string } | { error: string }> {
  if (!ofContact?.trim()) return { id: ctx.user.id };
  const found = await findContact(ctx.user.id, ofContact);
  if (found.length !== 1) return { error: found.length ? `Mais de um contato chamado ${ofContact}; pergunte qual.` : `${ofContact} não é contato no Planejai.` };
  const c = found[0]!;
  if (!(await canView(c.id, ctx.user.id, "finance"))) return { error: `${c.name} não compartilhou as finanças. Só ela pode liberar (pedindo pro assistente dela).` };
  return { id: c.id, name: c.name };
}

/** O que a pessoa falou nesta rodada (a linha da mensagem `messageId`, se houver), para achar o cartão que ela citou. */
function spokenText(ctx: { inboundText?: string; typedText?: string }, messageId?: string) {
  const all = ctx.inboundText || ctx.typedText || "";
  const line = messageId ? all.split("\n").find((l) => l.includes(`[msg_id=${messageId}]`)) : undefined;
  return (line ?? all).replace(/\[msg_id=\d+\]\s*/g, "").slice(0, 600);
}

/** "no débito", "pix", "dinheiro": não é cartão de crédito. */
const NO_CARD = /^(nenhum|sem cart[aã]o|n[aã]o|pix|dinheiro|esp[eé]cie|d[eé]bito|cart[aã]o de d[eé]bito|boleto|transfer[eê]ncia|ted|doc)$/i;

/** Ids de lançamentos mais as outras parcelas da mesma compra (para corrigir ou apagar a compra inteira). */
async function withInstallments(userId: string, ids: string[]) {
  const rows = await many<{ id: string }>(
    `SELECT t.id FROM transactions t WHERE t.user_id = $1 AND (t.id = ANY($2::uuid[]) OR t.purchase_id IN (
       SELECT p.purchase_id FROM transactions p WHERE p.user_id = $1 AND p.id = ANY($2::uuid[]) AND p.purchase_id IS NOT NULL AND p.installments > 1))`,
    [userId, ids],
  );
  return rows.map((r) => r.id);
}

const OF_CONTACT = { of_contact: { type: "string", description: "Nome de um contato que compartilhou as finanças (só leitura). Vazio = da própria pessoa." } };

/**
 * Grava um gasto/receita (parcelado = uma linha por parcela, mês a mês, sem perder centavos). No cartão, cada parcela
 * cai na fatura certa (`invoice_month`). Usado pelo agente e pelo painel. `ref(i)` evita duplicar o mesmo comprovante.
 */
export async function recordTransaction(p: {
  userId: string;
  kind: "expense" | "income";
  total: number;
  category: string;
  description?: string | null;
  merchant?: string | null;
  first: Date;
  installments?: number;
  source: string;
  ref?: (i: number) => string | null;
  card?: Card | null;
  tz: string;
}) {
  const n = Math.min(Math.max(1, Math.floor(p.installments ?? 1)), 48);
  const parts = splitInstallments(p.total, n);
  const firstInvoice = p.card ? invoiceMonthFor(p.card, localDate(p.first, p.tz)) : null;
  const purchaseId = n > 1 || p.card ? randomUUID() : null;
  const ids: string[] = [];
  const invoices: string[] = [];
  for (const [i, amount] of parts.entries()) {
    const when = shiftDate(p.first, i);
    const ref = p.ref?.(i) ?? null;
    const desc = n > 1 ? `${p.description ?? p.merchant ?? p.category} (${i + 1}/${n})` : (p.description ?? null);
    const invoice = firstInvoice ? addMonths(firstInvoice, i) : null;
    const row = await one(
      `INSERT INTO transactions (user_id, kind, amount, category, description, merchant, occurred_at, source, external_ref, card_id, invoice_month, purchase_id, installment, installments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (user_id, external_ref) WHERE external_ref IS NOT NULL DO NOTHING RETURNING id`,
      [p.userId, p.kind, amount, p.category, desc, p.merchant ?? null, when, p.source, ref, p.card?.id ?? null, invoice, purchaseId, n > 1 ? i + 1 : null, n > 1 ? n : null],
    );
    if (!row) return { duplicate: true as const, ids, parts, invoices };
    ids.push(row.id);
    if (invoice) invoices.push(invoice);
  }
  return { duplicate: false as const, ids, parts, invoices };
}

export const addTransaction = defineTool<{
  kind: "expense" | "income";
  amount: number | string;
  category?: string;
  description?: string;
  merchant?: string;
  date?: string;
  installments?: number;
  card?: string;
  source?: string;
  message_id?: string;
  item?: number;
  date_confirmed?: boolean;
  again?: boolean;
}>({
  name: "add_transaction",
  description:
    "Registra gasto ou receita NOVO, sem pedir confirmação (corrigir um já lançado é update_transaction). Parcelado: valor TOTAL + installments. Pagou com cartão (crédito, vale alimentação/refeição): card; cada parcela cai na fatura certa. " +
    "message_id evita lançar o mesmo comprovante duas vezes; vários itens na mesma mensagem: uma chamada por item com item=1, 2, 3…",
  parameters: obj(
    {
      kind: { type: "string", enum: ["expense", "income"] },
      amount: { type: "number", description: "Reais, ex.: 1234.56" },
      category: { type: "string", description: "Só se a pessoa disser; senão deixe vazio (o sistema acerta pelo que ela já corrigiu)" },
      description: { type: "string", description: "Curto, ex.: almoço" },
      merchant: { type: "string" },
      date: { type: "string", description: "AAAA-MM-DD[THH:MM]; padrão agora" },
      installments: { type: "number" },
      card: { type: "string", description: "Cartão que ela citou, do jeito que falou (Nubank, final 1234, vale alimentação, VR). Vazio = Pix/dinheiro/débito" },
      source: { type: "string", enum: ["conversa", "audio", "comprovante", "documento"] },
      message_id: { type: "string" },
      item: { type: "number" },
      date_confirmed: { type: "boolean", description: "true só se a pessoa disse uma data de mais de um ano atrás" },
      again: { type: "boolean", description: "true só se ela disse que é outro gasto igual a um de agora há pouco" },
    },
    ["kind", "amount"],
  ),
  async run(args, ctx) {
    const total = parseAmount(args.amount);
    if (total <= 0) return { ok: false, error: "Valor precisa ser maior que zero" };
    let card: Card | null = null;
    if (args.card?.trim() && !NO_CARD.test(args.card.trim())) {
      const found = await resolveCard(ctx.user.id, args.card);
      if ("error" in found) return { ok: false, error: found.error };
      card = found;
    }
    let cardNote: Record<string, string> = {};
    const said = !args.card?.trim() && args.kind === "expense" && !["comprovante", "documento"].includes(args.source ?? "") ? spokenText(ctx, args.message_id) : "";
    // "gastei 17,20 no vale alimentação" sem card: o modelo esqueceu, mas a pessoa disse. Cartão dela que bate vai junto.
    if (said) {
      const mine = await many<Card>("SELECT * FROM cards WHERE user_id = $1 AND active ORDER BY created_at", [ctx.user.id]);
      const hit = cardInText(said, mine);
      if (hit && "card" in hit) card = hit.card as Card;
      else if (hit)
        cardNote = {
          card_note: mine.length
            ? `Ela falou "${hit.said}", mas não deu para saber qual dos cartões dela (${mine.map((c) => c.name).join(", ")}): lancei SEM cartão. Não diga que foi no cartão; pergunte qual e corrija com update_transaction ids + card.`
            : `Ela falou "${hit.said}", mas não tem cartão cadastrado: lancei SEM cartão. Não diga que foi no cartão; pergunte se quer cadastrar (dia do fechamento e do vencimento) e passe ao Financeiro.`,
        };
    }
    // parcelou sem dizer onde: com um cartão só, é nele; com vários, lança sem cartão e pede para perguntar
    if (!card && !cardNote.card_note && !args.card?.trim() && args.kind === "expense" && Math.floor(args.installments ?? 1) > 1) {
      const mine = await many<Card>("SELECT * FROM cards WHERE user_id = $1 AND active ORDER BY created_at", [ctx.user.id]);
      if (mine.length === 1) {
        card = mine[0]!;
        cardNote = { card_note: `Lancei no cartão ${card.name}, o único dela. Se não foi no cartão, corrija com update_transaction card="nenhum".` };
      } else if (mine.length > 1)
        cardNote = { card_note: `Ela tem os cartões ${mine.map((c) => c.name).join(", ")}: pergunte em qual parcelou e corrija com update_transaction card (as parcelas acompanham).` };
    }
    const auto = await autoCategory(ctx.user.id, args.kind, args.category, args.description, args.merchant);
    const category = auto.category;
    const first = args.date ? parseLocalDateTime(args.date, ctx.timezone) : new Date();
    const odd = suspiciousDate(first, args);
    if (odd) return odd;
    // "esse gasto vai no cartão X" virava um 2º lançamento igual: mesmo valor e mesmo lugar de agora há pouco é para corrigir, não somar
    if (!args.again && !args.item) {
      const twin = await one<{ id: string; description: string | null; card: string | null; min: number }>(
        `SELECT t.id, COALESCE(t.description, t.merchant, t.category) AS description, c.name AS card,
                GREATEST(1, ROUND(EXTRACT(EPOCH FROM now() - t.created_at) / 60))::int AS min
           FROM transactions t LEFT JOIN cards c ON c.id = t.card_id
          WHERE t.user_id = $1 AND t.kind = $2 AND t.amount = $3 AND t.created_at > now() - interval '30 minutes'
            AND ($4::text IS NULL OR t.external_ref IS NULL OR t.external_ref NOT LIKE $4 || '%')
            AND (($5::text IS NULL AND $6::text IS NULL) OR lower(t.description) = lower($5) OR lower(t.merchant) = lower($6)
                 OR lower(t.description) = lower($6) OR lower(t.merchant) = lower($5))
          ORDER BY t.created_at DESC LIMIT 1`,
        [ctx.user.id, args.kind, total, args.message_id ?? null, args.description?.trim() || null, args.merchant?.trim() || null],
      );
      if (twin)
        return {
          ok: false,
          possible_duplicate: { id: twin.id, amount: brl(total), description: twin.description, card: twin.card ?? "sem cartão", lancado_ha: `${twin.min} min` },
          error:
            `Já tem ${brl(total)} (${twin.description}) lançado há ${twin.min} min. Se ela quer ajustar esse (cartão, valor, categoria, data), use update_transaction ids=["${twin.id}"]. ` +
            "Só se ela disse que é OUTRO gasto do mesmo valor, chame de novo com again=true. Na dúvida, pergunte.",
        };
    }
    // vários itens da mesma foto/lista não podem cair na mesma referência (o 2º virava "duplicado")
    const ref = args.message_id ? (i: number) => `${args.message_id}${args.item ? `#${Math.floor(args.item)}` : ""}:${i}` : undefined;
    const r = await recordTransaction({
      userId: ctx.user.id,
      kind: args.kind,
      total,
      category,
      description: args.description,
      merchant: args.merchant,
      first,
      installments: args.installments,
      source: args.source ?? "conversa",
      ref,
      card,
      tz: ctx.timezone,
    });
    if (r.duplicate && !r.ids.length)
      return {
        ok: true,
        duplicate: true,
        note: "Esse comprovante/mensagem já tinha sido lançado; nada foi duplicado. Se for outro item da mesma mensagem, chame de novo com item diferente.",
      };
    const { ids, parts } = r;
    const n = parts.length;
    const alerts = args.kind !== "expense" ? [] : await budgetAlerts(ctx.user.id, ctx.timezone, category, first);
    void emitEvent("transaction.created", { user_id: ctx.user.id, ids, kind: args.kind, amount: total, category, description: args.description ?? null, source: args.source ?? "conversa" });
    if (alerts.length) void emitEvent("budget.alert", { user_id: ctx.user.id, category, alerts });
    let cardInfo: Record<string, unknown> = {};
    if (card) {
      ctx.room?.done.add(CARD_USED);
      const s = (await listCards(ctx.user.id, ctx.timezone)).find((c) => c.id === card!.id);
      const firstInv = r.invoices[0]!;
      cardInfo = {
        card: card.name,
        first_invoice: `${monthName(firstInv)} (vence ${invoiceDates(card, firstInv).due.split("-").reverse().join("/")})`,
        ...(n > 1 ? { last_invoice: monthName(r.invoices[r.invoices.length - 1]!) } : {}),
        ...(s ? { card_open_invoice: brl(s.open.total), ...(s.available != null ? { card_available_limit: brl(s.available) } : {}) } : {}),
      };
    }
    return {
      ok: true,
      ids,
      amount: brl(total),
      ...(n > 1 ? { installments: n, installment_values: n > 6 ? `${brl(parts[1]!)} por mês${parts[0] !== parts[1] ? ` (a 1ª ${brl(parts[0]!)})` : ""}` : parts.map(brl) } : {}),
      category,
      ...categoryNote(auto, args.category),
      ...cardInfo,
      ...cardNote,
      ...(await monthTotals(ctx.user.id, ctx.timezone, first, category)),
      ...(alerts.length ? { budget_alert: alerts.join(" ") } : {}),
    };
  },
});

/** Só fala da categoria quando vale a pena (custa token): pediu uma e ficou outra, ou ela não tem categoria que sirva. */
function categoryNote(auto: { category: string; how: string }, asked?: string) {
  const want = asked?.trim();
  if (want && auto.how !== "pedido" && plain(want) !== plain(auto.category) && plain(want) !== "outros")
    return {
      category_note: ["corrigido", "palavra", "historico"].includes(auto.how)
        ? `Ficou em ${auto.category} porque ela já usa essa para esse lugar/descrição. Se ela pediu ${want} agora, corrija com update_transaction.`
        : `Ela não tem a categoria ${want}; ficou em ${auto.category}. Se ela quer ${want}, crie com categories e corrija com update_transaction.`,
    };
  if (auto.category === FALLBACK) return { category_note: "Não reconheci a categoria. Se ela disser qual é, corrija com update_transaction: os próximos parecidos já vão certo." };
  return {};
}

export const listTransactions = defineTool<{ from?: string; to?: string; category?: string; kind?: "expense" | "income"; search?: string; card?: string; limit?: number; of_contact?: string }>({
  name: "list_transactions",
  description: "Lista lançamentos (com id, para editar ou apagar). Filtros por período, categoria, tipo, texto (descrição ou estabelecimento) e cartão.",
  parameters: obj({
    from: { type: "string", description: "AAAA-MM-DD; padrão 30 dias atrás" },
    to: { type: "string", description: "AAAA-MM-DD (inclusivo)" },
    category: { type: "string" },
    kind: { type: "string", enum: ["expense", "income"] },
    search: { type: "string", description: "Parte da descrição ou do estabelecimento (ex.: 'uber')" },
    card: { type: "string", description: "Só as compras desse cartão" },
    limit: { type: "number" },
    ...OF_CONTACT,
  }),
  async run(args, ctx) {
    const who = await financeOwner(ctx, args.of_contact);
    if ("error" in who) return who;
    let cardId: string | null = null;
    if (args.card?.trim()) {
      const found = await resolveCard(who.id, args.card);
      if ("error" in found) return { ok: false, error: found.error };
      cardId = found.id;
    }
    const from = args.from ? parseLocalDateTime(args.from, ctx.timezone) : new Date(Date.now() - 30 * 86_400_000);
    const to = args.to ? new Date(parseLocalDateTime(args.to, ctx.timezone).getTime() + 86_400_000) : new Date(Date.now() + 86_400_000);
    const rows = await many(
      `SELECT t.id, t.kind, t.amount, t.category, t.description, t.merchant, to_char(t.occurred_at AT TIME ZONE $6, 'DD/MM/YYYY HH24:MI') AS quando,
              c.name AS card, t.invoice_month AS fatura, t.installment, t.installments
         FROM transactions t LEFT JOIN cards c ON c.id = t.card_id
        WHERE t.user_id = $1 AND t.occurred_at >= $2 AND t.occurred_at < $3 AND ($4::text IS NULL OR t.category = $4)
          AND ($7::text IS NULL OR t.kind = $7) AND ($8::text IS NULL OR t.description ILIKE $8 OR t.merchant ILIKE $8)
          AND ($9::uuid IS NULL OR t.card_id = $9)
        ORDER BY t.occurred_at DESC LIMIT $5`,
      [who.id, from, to, args.category ? ((await resolveCategory(who.id, args.category))?.name ?? args.category) : null, Math.min(args.limit ?? 50, 200), ctx.timezone, args.kind ?? null, args.search?.trim() ? `%${args.search.trim()}%` : null, cardId],
    );
    const sum = (k: string) => rows.reduce((acc, r) => acc + (r.kind === k ? Math.round(Number(r.amount) * 100) : 0), 0) / 100;
    return {
      ...(who.name ? { of: who.name, read_only: true } : {}),
      count: rows.length,
      total_expenses_listed: brl(sum("expense")),
      total_income_listed: brl(sum("income")),
      items: rows.map(({ card, fatura, installment, installments, ...r }) => ({
        ...r,
        amount: brl(cents(r.amount)),
        ...(card ? { card, fatura } : {}),
        ...(installments > 1 ? { parcela: `${installment}/${installments}` } : {}),
      })),
      ...(rows.some((r) => r.installments > 1) ? { note: "Parcela de compra parcelada: para corrigir ou apagar a compra inteira (todas as parcelas, inclusive as futuras), use all_installments=true." } : {}),
    };
  },
});

export const financeSummary = defineTool<{ month?: string; of_contact?: string }>({
  name: "finance_summary",
  description: "Resumo do mês: total de gastos, receitas, saldo e gastos por categoria.",
  parameters: obj({ month: { type: "string", description: "AAAA-MM; padrão mês atual" }, ...OF_CONTACT }),
  async run(args, ctx) {
    const who = await financeOwner(ctx, args.of_contact);
    if ("error" in who) return who;
    const month = args.month ?? new Intl.DateTimeFormat("en-CA", { timeZone: ctx.timezone, year: "numeric", month: "2-digit" }).format(new Date());
    const where = `user_id = $1 AND to_char(occurred_at AT TIME ZONE $2, 'YYYY-MM') = $3`;
    const totals = await one(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE kind='expense'),0) AS expenses, COALESCE(SUM(amount) FILTER (WHERE kind='income'),0) AS income, COUNT(*) AS count FROM transactions WHERE ${where}`,
      [who.id, ctx.timezone, month],
    );
    const byCategory = await many(
      `SELECT category, SUM(amount) AS total, COUNT(*) AS count FROM transactions WHERE ${where} AND kind='expense' GROUP BY category ORDER BY total DESC`,
      [who.id, ctx.timezone, month],
    );
    const prev = await one(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE kind='expense'),0) AS expenses FROM transactions
        WHERE user_id = $1 AND to_char(occurred_at AT TIME ZONE $2, 'YYYY-MM') = to_char(to_date($3, 'YYYY-MM') - interval '1 month', 'YYYY-MM')`,
      [who.id, ctx.timezone, month],
    );
    const expenses = cents(totals?.expenses);
    const income = cents(totals?.income);
    const cards = await listCards(who.id, ctx.timezone);
    // metas abertas entram no resumo: o Moacir comenta o mês já pensando nelas
    const { describeGoal, listGoals } = await import("../../goals.js");
    const goals = who.name ? [] : (await listGoals(who.id)).filter((g) => !g.done_at).map((g) => describeGoal(g, ctx.timezone));
    return {
      ...(goals.length ? { goals } : {}),
      ...(who.name ? { of: who.name, read_only: true } : {}),
      ...(cards.length
        ? { card_invoices: cards.map((c) => `${c.name}: próxima fatura ${brl(c.next.total)}, vence ${c.next.due.split("-").reverse().join("/")} (${c.next.status})`) }
        : {}),
      month,
      expenses: brl(expenses),
      income: brl(income),
      balance: brl(cents(income - expenses)),
      count: Number(totals?.count ?? 0),
      previous_month_expenses: brl(cents(prev?.expenses)),
      by_category: byCategory.map((c) => ({
        category: c.category,
        total: brl(cents(c.total)),
        count: Number(c.count),
        share: expenses ? `${Math.round((Number(c.total) / expenses) * 100)}%` : "0%",
      })),
    };
  },
});

/**
 * Trava de data: lançamento com data muito longe de hoje quase sempre é ano errado (foto ou print sem ano
 * virou 2020). Sem date_confirmed, devolve erro e o agente refaz com o ano certo.
 */
function suspiciousDate(when: Date, args: { date?: string; date_confirmed?: boolean }) {
  if (!args.date || args.date_confirmed) return null;
  const days = (when.getTime() - Date.now()) / 86_400_000;
  if (days > -400 && days < 62) return null;
  return {
    ok: false,
    error:
      `A data ${args.date} está longe de hoje. Data sem ano (foto, print, "dia 6") é do ano atual. ` +
      "Refaça com o ano certo; só use essa data se a pessoa disse o ano, passando date_confirmed=true.",
  };
}

export const updateTransaction = defineTool<{
  ids?: string[];
  last?: boolean;
  amount?: number | string;
  category?: string;
  description?: string;
  merchant?: string;
  date?: string;
  kind?: "expense" | "income";
  card?: string;
  all_installments?: boolean;
  date_confirmed?: boolean;
}>({
  name: "update_transaction",
  description:
    "Corrige lançamentos já feitos (ids de list_transactions, ou last=true para o último que ela lançou): valor, categoria, descrição, estabelecimento, data, tipo ou cartão. Vários ids = mesma mudança em todos. Sem confirmação.",
  parameters: obj(
    {
      ids: { type: "array", items: { type: "string" } },
      last: { type: "boolean", description: "true = o último lançamento dela (\"esse gasto\" de agora há pouco), sem ids" },
      amount: { type: "number" },
      category: { type: "string", description: "Uma categoria dela (lista em categories). Trocar ensina: os parecidos seguem essa daqui para frente" },
      description: { type: "string" },
      merchant: { type: "string" },
      date: { type: "string", description: "AAAA-MM-DD[THH:MM]" },
      kind: { type: "string", enum: ["expense", "income"] },
      card: { type: "string", description: "Muda para esse cartão; \"nenhum\" = não foi no cartão (vale para todas as parcelas)" },
      all_installments: { type: "boolean", description: "Aplica em todas as parcelas da mesma compra" },
      date_confirmed: { type: "boolean", description: "true só se a pessoa disse uma data de mais de um ano atrás" },
    },
  ),
  async run(args, ctx) {
    let ids = (args.ids ?? []).filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 200);
    if (!ids.length && args.last) {
      const last = await one<{ id: string }>("SELECT id FROM transactions WHERE user_id = $1 AND created_at > now() - interval '1 day' ORDER BY created_at DESC LIMIT 1", [ctx.user.id]);
      if (last) ids = [last.id];
    }
    if (!ids.length) return { ok: false, error: "Passe os ids (use list_transactions)" };
    // trocar de cartão é da compra inteira: as parcelas não podem ficar uma em cada cartão
    if (args.all_installments || args.card?.trim()) ids = await withInstallments(ctx.user.id, ids);
    const amount = args.amount != null && args.amount !== "" ? parseAmount(args.amount) : null;
    if (amount !== null && amount <= 0) return { ok: false, error: "Valor precisa ser maior que zero" };
    let category: string | null = null;
    if (args.category?.trim()) {
      const found = await resolveCategory(ctx.user.id, args.category);
      if (!found)
        return { ok: false, error: `Ela não tem a categoria "${args.category}". As dela: ${(await ensureCategories(ctx.user.id)).map((c) => c.name).join(", ")}. Se ela quer uma nova, crie com categories action=create e tente de novo.` };
      category = found.name;
    }
    const when = args.date ? parseLocalDateTime(args.date, ctx.timezone) : null;
    const odd = when && suspiciousDate(when, args);
    if (odd) return odd;
    let card: Card | null | undefined;
    if (args.card?.trim()) {
      if (NO_CARD.test(args.card.trim())) card = null;
      else {
        const found = await resolveCard(ctx.user.id, args.card);
        if ("error" in found) return { ok: false, error: found.error };
        card = found;
      }
    }
    const rows = await many(
      `UPDATE transactions SET amount = COALESCE($3, amount), category = COALESCE($4, category), description = COALESCE($5, description),
              merchant = COALESCE($6, merchant), occurred_at = COALESCE($7, occurred_at), kind = COALESCE($8, kind)
        WHERE user_id = $1 AND id = ANY($2::uuid[])
        RETURNING id, kind, amount, category, description, merchant, to_char(occurred_at AT TIME ZONE $9, 'DD/MM/YYYY HH24:MI') AS quando`,
      [ctx.user.id, ids, amount, category, args.description ?? null, args.merchant ?? null, when, args.kind ?? null, ctx.timezone],
    );
    if (!rows.length) return { ok: false, error: "Nenhum lançamento seu com esses ids" };
    // trocou a categoria: aprende para os próximos parecidos
    if (category) await learnCategory(ctx.user.id, rows.map((r) => ({ kind: r.kind, category: category!, merchant: r.merchant, description: r.description })));
    if (card !== undefined) {
      if (card) ctx.room?.done.add(CARD_USED);
      const changed = rows.map((r) => r.id as string);
      await query("UPDATE transactions SET card_id = $2, invoice_month = NULL WHERE user_id = $1 AND id = ANY($3::uuid[])", [ctx.user.id, card?.id ?? null, changed]);
      if (card) await placeOnCard(ctx.user.id, card, changed, ctx.timezone);
    } else if (when) {
      // mudou a data de compra no cartão: pode mudar de fatura
      for (const c of await many<Card>("SELECT DISTINCT c.* FROM cards c JOIN transactions t ON t.card_id = c.id WHERE t.user_id = $1 AND t.id = ANY($2::uuid[])", [ctx.user.id, rows.map((r) => r.id)]))
        await placeOnCard(ctx.user.id, c, rows.map((r) => r.id as string), ctx.timezone);
    }
    return { ok: true, updated: rows.length, ...(card !== undefined ? { card: card?.name ?? "nenhum" } : {}), items: rows.map((r) => ({ ...r, amount: brl(cents(r.amount)) })) };
  },
});

export const deleteTransaction = defineTool<{ ids?: string[]; id?: string; all_installments?: boolean; from?: string; to?: string; category?: string; search?: string; confirmed_by_user?: boolean }>({
  name: "delete_transaction",
  description:
    "Apaga lançamentos: um id que ela apontou sai direto; 2 ou mais ids, ou por filtro (período, categoria, texto), só depois do \"sim\" dela. Compra parcelada inteira: all_installments=true.",
  parameters: obj({
    ids: { type: "array", items: { type: "string" } },
    all_installments: { type: "boolean", description: "Apaga também as outras parcelas (passadas e futuras) da mesma compra" },
    from: { type: "string", description: "AAAA-MM-DD" },
    to: { type: "string", description: "AAAA-MM-DD (inclusivo)" },
    category: { type: "string" },
    search: { type: "string", description: "Trecho da descrição ou do estabelecimento" },
    ...CONFIRM_PARAM,
  }),
  async run(args, ctx) {
    let ids = [...(args.ids ?? []), ...(args.id ? [args.id] : [])].filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 200);
    if (ids.length && args.all_installments) ids = await withInstallments(ctx.user.id, ids);
    if (ids.length) {
      if (ids.length > 1) {
        const preview = await one("SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0) AS total FROM transactions WHERE user_id = $1 AND id = ANY($2::uuid[])", [ctx.user.id, ids]);
        if (!preview?.n) return { ok: false, error: "Nenhum desses lançamentos é dela" };
        const gate = await requireConfirmation(args, `apagar ${preview.n} lançamento(s) somando ${brl(cents(preview.total))}`, ctx);
        if (gate) return { ...gate, count: preview.n, total: brl(cents(preview.total)) };
      }
      const rows = await many("DELETE FROM transactions WHERE user_id = $1 AND id = ANY($2::uuid[]) RETURNING amount", [ctx.user.id, ids]);
      return { ok: rows.length > 0, deleted: rows.length, total: brl(cents(rows.reduce((a, r) => a + Number(r.amount), 0))) };
    }
    if (!args.from && !args.to && !args.category && !args.search?.trim()) return { ok: false, error: "Diga o que apagar: ids ou um filtro (período, categoria, texto)" };
    const from = args.from ? parseLocalDateTime(args.from, ctx.timezone) : new Date(0);
    const to = args.to ? new Date(parseLocalDateTime(args.to, ctx.timezone).getTime() + 86_400_000) : new Date(Date.now() + 366 * 86_400_000);
    const where = `user_id = $1 AND occurred_at >= $2 AND occurred_at < $3 AND ($4::text IS NULL OR category = $4) AND ($5::text IS NULL OR description ILIKE $5 OR merchant ILIKE $5)`;
    const params = [ctx.user.id, from, to, args.category ? ((await resolveCategory(ctx.user.id, args.category))?.name ?? args.category) : null, args.search?.trim() ? `%${args.search.trim()}%` : null];
    const preview = await one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0) AS total FROM transactions WHERE ${where}`, params);
    if (!preview?.n) return { ok: false, error: "Nenhum lançamento com esse filtro" };
    const gate = await requireConfirmation(args, `apagar ${preview.n} lançamento(s) somando ${brl(cents(preview.total))}`, ctx);
    if (gate) return { ...gate, count: preview.n, total: brl(cents(preview.total)) };
    const r = await query(`DELETE FROM transactions WHERE ${where}`, params);
    return { ok: true, deleted: r.rowCount ?? 0, total: brl(cents(preview.total)) };
  },
});

export const createPaymentLink = defineTool<{ title: string; amount: number; quantity?: number; confirmed_by_user?: boolean }>({
  name: "create_payment_link",
  integration: "mercadopago",
  description:
    "Gera um link de pagamento do Mercado Pago da própria pessoa (Pix, cartão, boleto) para cobrar alguém. " +
    "Exige confirmação explícita da pessoa com valor e descrição.",
  parameters: obj(
    {
      title: { type: "string" },
      amount: { type: "number", description: "Valor unitário em BRL" },
      quantity: { type: "number" },
      ...CONFIRM_PARAM,
    },
    ["title", "amount"],
  ),
  async run(args, ctx) {
    const qty = Math.max(1, Math.floor(args.quantity ?? 1));
    const amount = parseAmount(args.amount);
    const c = await requireConfirmation(args, `gerar link de pagamento "${args.title}" de ${brl(Math.round(amount * qty * 100) / 100)}`, ctx);
    if (c) return c;
    // conta da pessoa da conversa (integração pessoal): o dinheiro cai para quem cobrou
    const mp = await getCredentials("mercadopago");
    if (mp) {
      const res = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST",
        headers: { Authorization: `Bearer ${mp.access_token}`, "Content-Type": "application/json", "X-Idempotency-Key": randomUUID() },
        body: JSON.stringify({ items: [{ title: args.title, quantity: qty, unit_price: amount, currency_id: "BRL" }] }),
      });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Mercado Pago: ${JSON.stringify(j).slice(0, 300)}`);
      return { provider: "mercadopago", url: j.init_point, id: j.id };
    }
    return { ok: false, error: "Mercado Pago não conectado. A pessoa conecta o dela no painel, em Minha conta > Contas conectadas." };
  },
});
