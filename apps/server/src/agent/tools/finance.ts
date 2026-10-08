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

export const CATEGORIES = [
  "Alimentação",
  "Mercado",
  "Transporte",
  "Moradia",
  "Saúde",
  "Educação",
  "Lazer",
  "Compras",
  "Assinaturas",
  "Contas",
  "Viagem",
  "Salário",
  "Investimentos",
  "Outros",
];

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


const CATEGORY_RULES: [RegExp, string][] = [
  [/\b(salario|holerite|pagamento do trabalho|freela|pro labore|recebi do cliente)/, "Salário"],
  [/\b(investi|cdb|tesouro|acoes|acao da|poupanca|aporte|cripto|bitcoin|fundo imobiliario)/, "Investimentos"],
  [/\b(netflix|spotify|disney|hbo|max\b|prime video|amazon prime|youtube premium|icloud|google one|chatgpt|deezer|globoplay|assinatura|mensalidade do app)/, "Assinaturas"],
  [/\b(aluguel|condominio|iptu|financiamento da casa|reforma|moveis|diarista|faxina)/, "Moradia"],
  [/\b(luz|energia|enel|cemig|copel|agua|sabesp|internet|vivo|claro|tim\b|oi fibra|telefone|conta de gas|boleto|fatura)/, "Contas"],
  [/\b(mercado|supermercado|feira|hortifruti|atacadao|assai|carrefour|pao de acucar|extra\b|sacolao|acougue|compras do mes)/, "Mercado"],
  [/\b(almoco|jantar|lanche|cafe|padaria|restaurante|ifood|rappi|pizza|hamburguer|burger|mcdonald|bk\b|acai|sorvete|marmita|esfiha|sushi|churrasco|bar\b|cerveja|chopp|delivery)/, "Alimentação"],
  [/\b(uber|99\b|taxi|onibus|metro|trem|gasolina|etanol|combustivel|posto|estacionamento|pedagio|ipva|licenciamento|oficina|mecanico|lavagem|bilhete unico)/, "Transporte"],
  [/\b(farmacia|remedio|drogasil|droga raia|pague menos|consulta|medico|dentista|exame|hospital|plano de saude|unimed|terapia|psicologo|academia|smart fit|nutricionista)/, "Saúde"],
  [/\b(curso|faculdade|escola|livro|mensalidade escolar|material escolar|udemy|alura|apostila|idioma|ingles)/, "Educação"],
  [/\b(hotel|passagem|voo|aereo|airbnb|hospedagem|pousada|bagagem|viagem)/, "Viagem"],
  [/\b(cinema|ingresso|show|teatro|festa|balada|jogo|steam|playstation|xbox|parque|passeio|boliche|museu)/, "Lazer"],
  [/\b(roupa|camisa|calca|tenis|sapato|vestido|shopping|amazon|mercado livre|shopee|shein|magalu|presente|celular|iphone|fone|notebook|eletronico|perfume|maquiagem)/, "Compras"],
];

const plain = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** Categoria pelo texto, sem IA. Devolve null quando não reconhece. */
export function guessCategory(text: string): string | null {
  const t = plain(text);
  for (const [re, cat] of CATEGORY_RULES) if (re.test(t)) return cat;
  return null;
}

/**
 * Categoria automática: o que a própria pessoa já usou para o mesmo lugar/descrição vale mais,
 * depois as regras por palavra, depois o palpite do modelo, e por último "Outros".
 */
async function autoCategory(userId: string, kind: string, hint: string | undefined, description?: string, merchant?: string) {
  const key = (merchant || description || "").trim();
  if (key) {
    const learned = await one(
      `SELECT category FROM transactions WHERE user_id = $1 AND kind = $2 AND category <> 'Outros'
         AND (lower(merchant) = lower($3) OR lower(description) = lower($3)) ORDER BY occurred_at DESC LIMIT 1`,
      [userId, kind, key],
    );
    if (learned) return learned.category as string;
  }
  if (hint && CATEGORIES.includes(hint) && hint !== "Outros") return hint;
  const guessed = guessCategory(`${description ?? ""} ${merchant ?? ""}`);
  if (guessed) return guessed;
  return kind === "income" ? "Salário" : "Outros";
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
      category: { type: "string", enum: [...CATEGORIES, "Total"] },
      amount: { type: "number", description: "Reais por mês" },
      remove: { type: "boolean" },
    },
    ["amount"],
  ),
  async run(args, ctx) {
    const category = !args.category || args.category === "Total" ? null : CATEGORIES.includes(args.category) ? args.category : null;
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
    const cat = args.category && CATEGORIES.includes(args.category) ? args.category : null;
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

const OF_CONTACT = { of_contact: { type: "string", description: "Nome de um contato que compartilhou as finanças (só leitura). Vazio = da própria pessoa." } };

export const addTransaction = defineTool<{
  kind: "expense" | "income";
  amount: number | string;
  category?: string;
  description?: string;
  merchant?: string;
  date?: string;
  installments?: number;
  source?: string;
  message_id?: string;
  item?: number;
  date_confirmed?: boolean;
}>({
  name: "add_transaction",
  description:
    "Registra gasto ou receita, sem pedir confirmação. Parcelado: valor TOTAL + installments. " +
    "message_id evita lançar o mesmo comprovante duas vezes; vários itens na mesma mensagem: uma chamada por item com item=1, 2, 3…",
  parameters: obj(
    {
      kind: { type: "string", enum: ["expense", "income"] },
      amount: { type: "number", description: "Reais, ex.: 1234.56" },
      category: { type: "string", enum: CATEGORIES, description: "Só se a pessoa disser; senão é automática" },
      description: { type: "string", description: "Curto, ex.: almoço" },
      merchant: { type: "string" },
      date: { type: "string", description: "AAAA-MM-DD[THH:MM]; padrão agora" },
      installments: { type: "number" },
      source: { type: "string", enum: ["conversa", "audio", "comprovante", "documento"] },
      message_id: { type: "string" },
      item: { type: "number" },
      date_confirmed: { type: "boolean", description: "true só se a pessoa disse uma data de mais de um ano atrás" },
    },
    ["kind", "amount"],
  ),
  async run(args, ctx) {
    const total = parseAmount(args.amount);
    if (total <= 0) return { ok: false, error: "Valor precisa ser maior que zero" };
    const category = await autoCategory(ctx.user.id, args.kind, args.category, args.description, args.merchant);
    const first = args.date ? parseLocalDateTime(args.date, ctx.timezone) : new Date();
    const odd = suspiciousDate(first, args);
    if (odd) return odd;
    const n = Math.min(Math.max(1, Math.floor(args.installments ?? 1)), 48);
    const parts = splitInstallments(total, n);
    const ids: string[] = [];
    for (const [i, amount] of parts.entries()) {
      const when = new Date(first);
      when.setMonth(when.getMonth() + i);
      // vários itens da mesma foto/lista não podem cair na mesma referência (o 2º virava "duplicado")
      const ref = args.message_id ? `${args.message_id}${args.item ? `#${Math.floor(args.item)}` : ""}:${i}` : null;
      const desc = n > 1 ? `${args.description ?? args.merchant ?? category} (${i + 1}/${n})` : (args.description ?? null);
      const row = await one(
        `INSERT INTO transactions (user_id, kind, amount, category, description, merchant, occurred_at, source, external_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (user_id, external_ref) WHERE external_ref IS NOT NULL DO NOTHING RETURNING id`,
        [ctx.user.id, args.kind, amount, category, desc, args.merchant ?? null, when, args.source ?? "conversa", ref],
      );
      if (!row)
        return {
          ok: true,
          duplicate: true,
          note: "Esse comprovante/mensagem já tinha sido lançado; nada foi duplicado. Se for outro item da mesma mensagem, chame de novo com item diferente.",
        };
      ids.push(row.id);
    }
    const alerts = args.kind !== "expense" ? [] : await budgetAlerts(ctx.user.id, ctx.timezone, category, first);
    void emitEvent("transaction.created", { user_id: ctx.user.id, ids, kind: args.kind, amount: total, category, description: args.description ?? null, source: args.source ?? "conversa" });
    if (alerts.length) void emitEvent("budget.alert", { user_id: ctx.user.id, category, alerts });
    return {
      ok: true,
      ids,
      amount: brl(total),
      ...(n > 1 ? { installments: n, installment_values: parts.map(brl) } : {}),
      category,
      ...(await monthTotals(ctx.user.id, ctx.timezone, first, category)),
      ...(alerts.length ? { budget_alert: alerts.join(" ") } : {}),
    };
  },
});

export const listTransactions = defineTool<{ from?: string; to?: string; category?: string; kind?: "expense" | "income"; search?: string; limit?: number; of_contact?: string }>({
  name: "list_transactions",
  description: "Lista lançamentos (com id, para editar ou apagar). Filtros por período, categoria, tipo e texto (descrição ou estabelecimento).",
  parameters: obj({
    from: { type: "string", description: "AAAA-MM-DD; padrão 30 dias atrás" },
    to: { type: "string", description: "AAAA-MM-DD (inclusivo)" },
    category: { type: "string" },
    kind: { type: "string", enum: ["expense", "income"] },
    search: { type: "string", description: "Parte da descrição ou do estabelecimento (ex.: 'uber')" },
    limit: { type: "number" },
    ...OF_CONTACT,
  }),
  async run(args, ctx) {
    const who = await financeOwner(ctx, args.of_contact);
    if ("error" in who) return who;
    const from = args.from ? parseLocalDateTime(args.from, ctx.timezone) : new Date(Date.now() - 30 * 86_400_000);
    const to = args.to ? new Date(parseLocalDateTime(args.to, ctx.timezone).getTime() + 86_400_000) : new Date(Date.now() + 86_400_000);
    const rows = await many(
      `SELECT id, kind, amount, category, description, merchant, to_char(occurred_at AT TIME ZONE $6, 'DD/MM/YYYY HH24:MI') AS quando FROM transactions
        WHERE user_id = $1 AND occurred_at >= $2 AND occurred_at < $3 AND ($4::text IS NULL OR category = $4)
          AND ($7::text IS NULL OR kind = $7) AND ($8::text IS NULL OR description ILIKE $8 OR merchant ILIKE $8)
        ORDER BY occurred_at DESC LIMIT $5`,
      [who.id, from, to, args.category ?? null, Math.min(args.limit ?? 50, 200), ctx.timezone, args.kind ?? null, args.search?.trim() ? `%${args.search.trim()}%` : null],
    );
    const sum = (k: string) => rows.reduce((acc, r) => acc + (r.kind === k ? Math.round(Number(r.amount) * 100) : 0), 0) / 100;
    return {
      ...(who.name ? { of: who.name, read_only: true } : {}),
      count: rows.length,
      total_expenses_listed: brl(sum("expense")),
      total_income_listed: brl(sum("income")),
      items: rows.map((r) => ({ ...r, amount: brl(cents(r.amount)) })),
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
    return {
      ...(who.name ? { of: who.name, read_only: true } : {}),
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
  ids: string[];
  amount?: number | string;
  category?: string;
  description?: string;
  merchant?: string;
  date?: string;
  kind?: "expense" | "income";
  date_confirmed?: boolean;
}>({
  name: "update_transaction",
  description:
    "Corrige lançamentos (ids de list_transactions): valor, categoria, descrição, estabelecimento, data ou tipo. Vários ids = mesma mudança em todos. Sem confirmação.",
  parameters: obj(
    {
      ids: { type: "array", items: { type: "string" } },
      amount: { type: "number" },
      category: { type: "string", enum: CATEGORIES },
      description: { type: "string" },
      merchant: { type: "string" },
      date: { type: "string", description: "AAAA-MM-DD[THH:MM]" },
      kind: { type: "string", enum: ["expense", "income"] },
      date_confirmed: { type: "boolean", description: "true só se a pessoa disse uma data de mais de um ano atrás" },
    },
    ["ids"],
  ),
  async run(args, ctx) {
    const ids = (args.ids ?? []).filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 200);
    if (!ids.length) return { ok: false, error: "Passe os ids (use list_transactions)" };
    const amount = args.amount != null && args.amount !== "" ? parseAmount(args.amount) : null;
    if (amount !== null && amount <= 0) return { ok: false, error: "Valor precisa ser maior que zero" };
    const when = args.date ? parseLocalDateTime(args.date, ctx.timezone) : null;
    const odd = when && suspiciousDate(when, args);
    if (odd) return odd;
    const rows = await many(
      `UPDATE transactions SET amount = COALESCE($3, amount), category = COALESCE($4, category), description = COALESCE($5, description),
              merchant = COALESCE($6, merchant), occurred_at = COALESCE($7, occurred_at), kind = COALESCE($8, kind)
        WHERE user_id = $1 AND id = ANY($2::uuid[])
        RETURNING id, kind, amount, category, description, merchant, to_char(occurred_at AT TIME ZONE $9, 'DD/MM/YYYY HH24:MI') AS quando`,
      [ctx.user.id, ids, amount, args.category && CATEGORIES.includes(args.category) ? args.category : null, args.description ?? null, args.merchant ?? null, when, args.kind ?? null, ctx.timezone],
    );
    if (!rows.length) return { ok: false, error: "Nenhum lançamento seu com esses ids" };
    return { ok: true, updated: rows.length, items: rows.map((r) => ({ ...r, amount: brl(cents(r.amount)) })) };
  },
});

export const deleteTransaction = defineTool<{ ids?: string[]; id?: string; from?: string; to?: string; category?: string; search?: string; confirmed_by_user?: boolean }>({
  name: "delete_transaction",
  description:
    "Apaga lançamentos: um id que ela apontou sai direto; 2 ou mais ids, ou por filtro (período, categoria, texto), só depois do \"sim\" dela.",
  parameters: obj({
    ids: { type: "array", items: { type: "string" } },
    from: { type: "string", description: "AAAA-MM-DD" },
    to: { type: "string", description: "AAAA-MM-DD (inclusivo)" },
    category: { type: "string" },
    search: { type: "string", description: "Trecho da descrição ou do estabelecimento" },
    ...CONFIRM_PARAM,
  }),
  async run(args, ctx) {
    const ids = [...(args.ids ?? []), ...(args.id ? [args.id] : [])].filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 200);
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
    const params = [ctx.user.id, from, to, args.category ?? null, args.search?.trim() ? `%${args.search.trim()}%` : null];
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
