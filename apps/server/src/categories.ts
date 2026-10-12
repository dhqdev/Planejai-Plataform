import { many, one, query } from "./db/pool.js";

/**
 * Categorias de gastos de cada pessoa (Finanças > Categorias e a ferramenta `categories` do Moacir).
 * Quem nunca mexeu ganha as de sempre na primeira vez que precisa. Renomear e excluir levam junto os
 * lançamentos, limites, contas fixas e o que foi aprendido; o nome antigo vira apelido (aliases), então
 * as regras por palavra e o modelo ainda acham a categoria certa.
 *
 * Categoria automática sem IA (autoCategory): correção que a pessoa já fez > palavras da categoria >
 * histórico do mesmo lugar > o que o modelo mandou > regras por palavra > Outros.
 */

export type CategoryKind = "expense" | "income" | "both";

export interface Category {
  id: string;
  name: string;
  color: string;
  kind: CategoryKind;
  keywords: string[];
  aliases: string[];
  position: number;
}

/** Paleta das categorias (a mesma dos gráficos), na ordem em que uma categoria nova pega cor. */
export const CATEGORY_PALETTE = ["#FF7A1A", "#FF4458", "#E23382", "#B830C8", "#8B2BE2", "#5B45E8", "#2F7BEA", "#16A3A3", "#2E9E5B", "#C9A227", "#8D6E63", "#9AA0A6"];

export const DEFAULT_CATEGORIES: { name: string; color: string; kind: CategoryKind }[] = [
  { name: "Alimentação", color: "#FF7A1A", kind: "expense" },
  { name: "Mercado", color: "#C9A227", kind: "expense" },
  { name: "Transporte", color: "#2F7BEA", kind: "expense" },
  { name: "Moradia", color: "#8D6E63", kind: "expense" },
  { name: "Saúde", color: "#FF4458", kind: "expense" },
  { name: "Educação", color: "#5B45E8", kind: "expense" },
  { name: "Lazer", color: "#E23382", kind: "expense" },
  { name: "Compras", color: "#B830C8", kind: "expense" },
  { name: "Assinaturas", color: "#8B2BE2", kind: "expense" },
  { name: "Contas", color: "#16A3A3", kind: "expense" },
  { name: "Viagem", color: "#2E9E5B", kind: "expense" },
  { name: "Salário", color: "#2E9E5B", kind: "income" },
  { name: "Investimentos", color: "#5B45E8", kind: "both" },
  { name: "Outros", color: "#9AA0A6", kind: "both" },
];

/** Nomes das categorias de sempre (quem nunca mexeu tem exatamente estas). */
export const CATEGORIES = DEFAULT_CATEGORIES.map((c) => c.name);

/** "Outros" é a rede de segurança: pode trocar a cor, mas não renomear nem excluir. */
export const FALLBACK = "Outros";
export const MAX_CATEGORIES = 40;

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

/** Minúsculas e sem acento. */
export const plain = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Categoria de sempre pelo texto, sem IA. Devolve null quando não reconhece. */
export function guessCategory(text: string): string | null {
  const t = plain(text);
  for (const [re, cat] of CATEGORY_RULES) if (re.test(t)) return cat;
  return null;
}

/** Texto comparável: sem acento, sem "(2/10)", números e pontuação. */
export function learnKey(s: string | null | undefined): string | null {
  const k = plain(String(s ?? ""))
    .replace(/\(\d+\/\d+\)/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return k.length >= 3 ? k : null;
}

/** "Alimentação", "alimentacao" e "alimentações" são a mesma; nomes antigos (aliases) também valem. */
export function matchCategory(cats: Category[], text: string | null | undefined): Category | null {
  const t = plain(String(text ?? "")).trim();
  if (!t) return null;
  const same = (a: string) => {
    const p = plain(a).trim();
    return p === t || p.replace(/s$/, "") === t.replace(/s$/, "");
  };
  return cats.find((c) => same(c.name)) ?? cats.find((c) => c.aliases.some(same)) ?? null;
}

const fits = (c: Category, kind: string) => c.kind === "both" || c.kind === kind;
const hasPhrase = (text: string, phrase: string) => phrase.length >= 3 && ` ${text} `.includes(` ${phrase} `);
const cleanName = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
const cleanColor = (s: unknown) => (/^#[0-9a-f]{6}$/i.test(String(s ?? "")) ? String(s).toUpperCase() : null);
const cleanKeywords = (v: unknown) => {
  const list = Array.isArray(v) ? v : String(v ?? "").split(/[,;\n]/);
  // guarda como ela escreveu (com acento); compara sem acento
  const out = new Map<string, string>();
  for (const k of list) {
    const word = String(k).replace(/\s+/g, " ").trim().toLowerCase().slice(0, 40);
    const key = learnKey(word);
    if (key && !out.has(key)) out.set(key, word);
  }
  return [...out.values()].slice(0, 30);
};

/** Categorias da pessoa; na primeira vez cria as de sempre e as que ela já usa nos lançamentos antigos. */
export async function ensureCategories(userId: string): Promise<Category[]> {
  const sql = "SELECT id, name, color, kind, keywords, aliases, position FROM finance_categories WHERE user_id = $1 ORDER BY position, created_at";
  const rows = await many<Category>(sql, [userId]);
  if (rows.length) return rows;
  const used = await many<{ category: string }>(
    `SELECT DISTINCT category FROM (SELECT category FROM transactions WHERE user_id = $1 UNION SELECT category FROM budgets WHERE user_id = $1 AND category IS NOT NULL
       UNION SELECT category FROM bills WHERE user_id = $1) x`,
    [userId],
  );
  const extra = used.map((u) => u.category).filter((c) => c && !CATEGORIES.includes(c));
  const all = [...DEFAULT_CATEGORIES, ...extra.map((name, i) => ({ name, color: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]!, kind: "expense" as const }))];
  await query(
    `INSERT INTO finance_categories (user_id, name, color, kind, position)
     SELECT $1, n, c, k, p FROM unnest($2::text[], $3::text[], $4::text[], $5::int[]) AS t(n, c, k, p)
     ON CONFLICT DO NOTHING`,
    [userId, all.map((c) => c.name), all.map((c) => c.color), all.map((c) => c.kind), all.map((_, i) => i)],
  );
  return many<Category>(sql, [userId]);
}

/** Categoria dela pelo nome (sem acento, plural ou nome antigo). */
export async function resolveCategory(userId: string, text: string | null | undefined) {
  return matchCategory(await ensureCategories(userId), text);
}

/** Nome válido para gravar: o que bate com uma categoria dela, senão o padrão (que existe sempre). */
export async function categoryOr(userId: string, text: string | null | undefined, fallback: string) {
  const cats = await ensureCategories(userId);
  return (matchCategory(cats, text) ?? matchCategory(cats, fallback) ?? matchCategory(cats, FALLBACK))?.name ?? FALLBACK;
}

/**
 * Categoria automática, sem IA. `how` diz de onde veio (o modelo não precisa adivinhar):
 * corrigido (ela já trocou a categoria de um parecido), palavra (palavra que ela pôs na categoria),
 * historico (mesmo lugar já lançado), pedido (o que veio na chamada), regra, padrao.
 */
export async function autoCategory(userId: string, kind: string, hint?: string | null, description?: string | null, merchant?: string | null) {
  const cats = await ensureCategories(userId);
  const text = learnKey(`${description ?? ""} ${merchant ?? ""}`) ?? "";
  const keys = [learnKey(merchant), learnKey(description)].filter((k): k is string => Boolean(k));
  const valid = (name: string | null | undefined) => matchCategory(cats, name);
  if (text) {
    const learned = await many<{ key: string; category: string }>(
      "SELECT key, category FROM category_learned WHERE user_id = $1 AND kind = $2 ORDER BY updated_at DESC LIMIT 500",
      [userId, kind],
    );
    const exact = learned.find((l) => keys.includes(l.key));
    const near = exact ?? learned.filter((l) => hasPhrase(text, l.key)).sort((a, b) => b.key.length - a.key.length)[0];
    const c = near && valid(near.category);
    if (c) return { category: c.name, how: "corrigido" as const };
    const byWord = cats.filter((c) => fits(c, kind)).find((c) => c.keywords.some((k) => hasPhrase(text, learnKey(k) ?? "")));
    if (byWord) return { category: byWord.name, how: "palavra" as const };
  }
  const key = (merchant || description || "").trim();
  if (key) {
    const past = await one(
      `SELECT category FROM transactions WHERE user_id = $1 AND kind = $2 AND category <> $4
         AND (lower(merchant) = lower($3) OR lower(description) = lower($3)) ORDER BY occurred_at DESC LIMIT 1`,
      [userId, kind, key, FALLBACK],
    );
    const c = past && valid(past.category);
    if (c) return { category: c.name, how: "historico" as const };
  }
  const asked = valid(hint);
  if (asked && asked.name !== FALLBACK) return { category: asked.name, how: "pedido" as const };
  const ruled = valid(guessCategory(`${description ?? ""} ${merchant ?? ""}`));
  if (ruled) return { category: ruled.name, how: "regra" as const };
  const fallback = (kind === "income" ? valid("Salário") : null) ?? valid(FALLBACK);
  return { category: fallback?.name ?? FALLBACK, how: "padrao" as const };
}

/** Ela trocou a categoria: o lugar e a descrição passam a ir para essa categoria daqui para frente. */
export async function learnCategory(userId: string, rows: { kind: string; category: string; merchant?: string | null; description?: string | null }[]) {
  const seen = new Set<string>();
  for (const r of rows.slice(0, 50)) {
    for (const key of [learnKey(r.merchant), learnKey(r.description)]) {
      if (!key || seen.has(`${r.kind}:${key}`)) continue;
      seen.add(`${r.kind}:${key}`);
      await query(
        `INSERT INTO category_learned (user_id, kind, key, category) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, kind, key) DO UPDATE SET category = $4, hits = category_learned.hits + 1, updated_at = now()`,
        [userId, r.kind, key, r.category],
      );
    }
  }
  // guarda só as 500 mais recentes por pessoa
  await query(
    `DELETE FROM category_learned WHERE user_id = $1 AND (kind, key) NOT IN
       (SELECT kind, key FROM category_learned WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 500)`,
    [userId],
  );
}

/** Categorias com quantos lançamentos e quanto foi no mês (para a tela e para o Moacir). */
export async function listCategories(userId: string, tz: string, month?: string) {
  const cats = await ensureCategories(userId);
  const m = month ?? new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).format(new Date());
  const use = await many<{ category: string; n: number; month_total: number }>(
    `SELECT category, COUNT(*)::int AS n, COALESCE(SUM(amount) FILTER (WHERE to_char(occurred_at AT TIME ZONE $2, 'YYYY-MM') = $3), 0)::float AS month_total
       FROM transactions WHERE user_id = $1 GROUP BY category`,
    [userId, tz, m],
  );
  const by = new Map(use.map((u) => [u.category, u]));
  return cats.map((c) => ({ ...c, count: by.get(c.name)?.n ?? 0, month_total: by.get(c.name)?.month_total ?? 0, fixed: c.name === FALLBACK }));
}

export interface CategoryInput {
  name?: string;
  color?: string;
  kind?: string;
  keywords?: string[] | string;
}

function nextColor(cats: Category[]) {
  const used = new Set(cats.map((c) => c.color.toUpperCase()));
  return CATEGORY_PALETTE.find((c) => !used.has(c)) ?? CATEGORY_PALETTE[cats.length % CATEGORY_PALETTE.length]!;
}

const kindOf = (k: unknown): CategoryKind | null => (k === "expense" || k === "income" || k === "both" ? k : null);

export async function createCategory(userId: string, input: CategoryInput) {
  const cats = await ensureCategories(userId);
  const name = cleanName(input.name);
  if (!name) throw new Error("Diga o nome da categoria");
  const same = cats.find((c) => plain(c.name) === plain(name));
  if (same) throw new Error(`Já existe a categoria ${same.name}`);
  if (cats.length >= MAX_CATEGORIES) throw new Error(`Dá para ter até ${MAX_CATEGORIES} categorias. Exclua ou junte alguma antes.`);
  const row = await one<Category>(
    `INSERT INTO finance_categories (user_id, name, color, kind, keywords, position)
     VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(MAX(position), 0) + 1 FROM finance_categories WHERE user_id = $1))
     RETURNING id, name, color, kind, keywords, aliases, position`,
    [userId, name, cleanColor(input.color) ?? nextColor(cats), kindOf(input.kind) ?? "expense", cleanKeywords(input.keywords)],
  );
  // o nome novo deixa de ser apelido de outra (ex.: recriou "Delivery" depois de juntar em Alimentação)
  await query("UPDATE finance_categories SET aliases = array_remove(aliases, $2) WHERE user_id = $1 AND id <> $3", [userId, name, row!.id]);
  return row!;
}

async function findOwn(userId: string, idOrName: string) {
  const cats = await ensureCategories(userId);
  const c = cats.find((x) => x.id === idOrName) ?? matchCategory(cats, idOrName);
  if (!c) throw new Error(`Não achei a categoria "${idOrName}". As dela: ${cats.map((x) => x.name).join(", ")}`);
  return { c, cats };
}

/** Renomeia (leva lançamentos, limites, contas fixas e o aprendido junto), troca cor, tipo ou palavras. */
export async function updateCategory(userId: string, idOrName: string, input: CategoryInput) {
  const { c, cats } = await findOwn(userId, idOrName);
  const name = input.name !== undefined ? cleanName(input.name) : c.name;
  if (!name) throw new Error("O nome não pode ficar vazio");
  const renamed = name !== c.name;
  if (renamed && c.name === FALLBACK) throw new Error(`${FALLBACK} não muda de nome: é para onde vai o que não tem categoria`);
  if (renamed && cats.some((x) => x.id !== c.id && plain(x.name) === plain(name))) throw new Error(`Já existe a categoria ${name}. Para juntar as duas, exclua esta e mande os lançamentos para lá.`);
  const color = input.color !== undefined ? (cleanColor(input.color) ?? c.color) : c.color;
  const kind = (input.kind !== undefined ? kindOf(input.kind) : null) ?? c.kind;
  const keywords = input.keywords !== undefined ? cleanKeywords(input.keywords) : c.keywords;
  const aliases = renamed ? [...new Set([...c.aliases.filter((a) => plain(a) !== plain(name)), c.name])].slice(-20) : c.aliases;
  const row = await one<Category>(
    `UPDATE finance_categories SET name = $3, color = $4, kind = $5, keywords = $6, aliases = $7 WHERE user_id = $1 AND id = $2
     RETURNING id, name, color, kind, keywords, aliases, position`,
    [userId, c.id, name, color, kind, keywords, aliases],
  );
  const moved = renamed ? await moveCategory(userId, c.name, name) : 0;
  return { ...row!, moved, old_name: renamed ? c.name : undefined };
}

/** Exclui e manda tudo que era dela para outra categoria (padrão Outros). */
export async function deleteCategory(userId: string, idOrName: string, moveTo?: string | null) {
  const { c, cats } = await findOwn(userId, idOrName);
  if (c.name === FALLBACK) throw new Error(`${FALLBACK} não pode ser excluída: é para onde vai o que não tem categoria`);
  const target = matchCategory(cats.filter((x) => x.id !== c.id), moveTo || FALLBACK);
  if (!target) throw new Error(`Não achei a categoria "${moveTo}" para mandar os lançamentos`);
  await query(
    `UPDATE finance_categories SET aliases = COALESCE((SELECT array_agg(DISTINCT a) FROM unnest(aliases || $3::text[]) a), '{}'),
            keywords = COALESCE((SELECT array_agg(DISTINCT k) FROM unnest(keywords || $4::text[]) k), '{}')
      WHERE user_id = $1 AND id = $2`,
    [userId, target.id, [c.name, ...c.aliases], c.keywords],
  );
  const moved = await moveCategory(userId, c.name, target.name);
  await query("DELETE FROM finance_categories WHERE user_id = $1 AND id = $2", [userId, c.id]);
  return { deleted: c.name, moved_to: target.name, moved };
}

/** Passa lançamentos, contas fixas, aprendizado e limite de uma categoria para outra. Devolve quantos lançamentos. */
async function moveCategory(userId: string, from: string, to: string) {
  const tx = await query("UPDATE transactions SET category = $3 WHERE user_id = $1 AND category = $2", [userId, from, to]);
  await query("UPDATE bills SET category = $3 WHERE user_id = $1 AND category = $2", [userId, from, to]);
  await query("UPDATE category_learned SET category = $3 WHERE user_id = $1 AND category = $2", [userId, from, to]);
  // limite: se o destino já tem um, fica o dele
  await query(
    `DELETE FROM budgets WHERE user_id = $1 AND category = $2 AND EXISTS (SELECT 1 FROM budgets WHERE user_id = $1 AND category = $3)`,
    [userId, from, to],
  );
  await query("UPDATE budgets SET category = $3 WHERE user_id = $1 AND category = $2", [userId, from, to]);
  return tx.rowCount ?? 0;
}
