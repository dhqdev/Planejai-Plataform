import { recordTransaction } from "./agent/tools/finance.js";
import { getCard, listCards } from "./cards.js";
import { autoCategory, CATEGORY_PALETTE, createCategory, ensureCategories, FALLBACK, guessCategory, learnCategory, matchCategory, plain } from "./categories.js";
import { many } from "./db/pool.js";
import { decodeOfx, parseOfx, type OfxStatement } from "./ofx.js";

/**
 * Importar extrato OFX em Finanças (pedido do David em 2026-10-20). Duas etapas, sem IA:
 * prévia (cada linha já com a categoria automática da pessoa, o que parece repetido e o que não deve contar)
 * e importar (o servidor lê o arquivo de novo, então valor e data vêm sempre do banco, nunca do navegador).
 * Nada duplica: cada linha vira `external_ref` = ofx:<banco>:<conta>:<FITID>.
 */

export const MAX_OFX_BYTES = 3 * 1024 * 1024;

/** Categorias novas que um extrato costuma pedir e as de sempre não cobrem; sugeridas quando ela não tem. */
const SUGGESTED: { re: RegExp; name: string; kind: "expense" | "income" | "both"; keywords: string[] }[] = [
  { re: /\b(tarifa|iof|juros|anuidade|cesta de servicos|pacote de servicos|encargo|multa)\b/, name: "Tarifas bancárias", kind: "expense", keywords: ["tarifa", "iof", "anuidade", "juros"] },
  { re: /\b(pet ?shop|petz|cobasi|petlove|veterinari|racao)/, name: "Pets", kind: "expense", keywords: ["petshop", "veterinário", "ração"] },
  { re: /\b(salao|barbearia|cabeleireir|manicure|estetica|depilacao)/, name: "Beleza", kind: "expense", keywords: ["salão", "barbearia", "manicure"] },
  { re: /\b(pix|ted|doc|transf)/, name: "Transferências", kind: "both", keywords: [] },
];

/** O que não é gasto nem receita de verdade: entra desmarcado, com o motivo. */
function skipReason(text: string, cents: number, creditCard: boolean): string | null {
  const t = plain(text);
  if (creditCard && cents > 0 && /\b(pagamento|pgto|pag)\b/.test(t)) return "Pagamento da fatura: as compras já estão no extrato";
  if (!creditCard && /\b(pagamento|pgto|pagto|pag)\b.*\bfatura|fatura.*\b(cartao|pagamento)|pagamento cartao( de)? credito/.test(t)) return "Pagamento de fatura: as compras do cartão já contam";
  if (/\b(aplicacao|resgate|aplic)\b.*\b(automatic|cdb|poupanca|rdb|invest)|^(aplicacao|resgate)\b/.test(t)) return "Aplicação ou resgate: dinheiro seu mudando de lugar";
  if (/\bsaldo (anterior|do dia|total)\b/.test(t)) return "Linha de saldo";
  return null;
}

export interface PreviewRow {
  ref: string;
  date: string;
  kind: "expense" | "income";
  amount: number;
  description: string;
  merchant: string | null;
  category: string;
  /** de onde veio a categoria: corrigido, palavra, historico, regra, padrao ou nova (sugestão de categoria que ela ainda não tem) */
  how: string;
  /** já importado antes (mesmo FITID) */
  imported: boolean;
  /** parece com um lançamento que ela já fez (WhatsApp ou painel): mesmo valor, mesmo tipo, até 3 dias de diferença */
  similar: { id: string; description: string; date: string } | null;
  skip: string | null;
}

const refOf = (st: OfxStatement, ref: string) => `ofx:${st.bankId ?? "x"}:${(st.account ?? "x").replace(/\s/g, "")}:${ref}`.slice(0, 200);

export function readOfx(base64: string) {
  const bytes = Buffer.from(String(base64 ?? ""), "base64");
  if (!bytes.length) throw new Error("Arquivo vazio");
  if (bytes.length > MAX_OFX_BYTES) throw new Error("Arquivo grande demais (até 3 MB). Exporte um período menor no banco.");
  const st = parseOfx(decodeOfx(bytes));
  if (st.currency !== "BRL") throw new Error(`Esse extrato está em ${st.currency}. Por enquanto só importo em reais.`);
  if (!st.transactions.length) throw new Error("Não achei lançamentos nesse extrato. Confira o período exportado no banco.");
  return st;
}

/** Prévia: tudo calculado, nada gravado. */
export async function previewOfx(userId: string, base64: string) {
  const st = readOfx(base64);
  const cats = await ensureCategories(userId);
  const refs = st.transactions.map((t) => refOf(st, t.ref));
  const done = new Set((await many<{ external_ref: string }>("SELECT external_ref FROM transactions WHERE user_id = $1 AND external_ref = ANY($2)", [userId, refs])).map((r) => r.external_ref));
  const dates = st.transactions.map((t) => t.date).sort();
  // lançamentos que ela já fez no período (fora de OFX), para avisar do que parece repetido
  const mine = await many<{ id: string; kind: string; amount: string; description: string | null; merchant: string | null; category: string; day: string }>(
    `SELECT id, kind, amount, description, merchant, category, to_char(occurred_at, 'YYYY-MM-DD') AS day FROM transactions
      WHERE user_id = $1 AND (external_ref IS NULL OR external_ref NOT LIKE 'ofx:%')
        AND occurred_at BETWEEN $2::date - 3 AND $3::date + 4`,
    [userId, dates[0], dates[dates.length - 1]],
  );
  const used = new Set<string>();
  const suggested = new Map<string, { name: string; kind: string; keywords: string[]; color: string }>();
  const rows: PreviewRow[] = [];
  for (const t of st.transactions) {
    const kind = t.cents < 0 ? "expense" : "income";
    const amount = Math.abs(t.cents) / 100;
    const text = `${t.description} ${t.merchant ?? ""}`;
    let { category, how } = await autoCategory(userId, kind, null, t.description, t.merchant);
    // as regras gerais erram "Petz Shopping" (Compras): as do extrato são mais específicas e vencem a regra
    const specific = SUGGESTED.find((x) => x.re.test(plain(text)) && (x.kind === "both" || x.kind === kind) && (how === "padrao" || x.keywords.length > 0));
    if (how === "padrao" || (how === "regra" && specific)) {
      // uma das que o extrato costuma pedir, ou a categoria de sempre que ela excluiu
      const rule = guessCategory(text);
      const s = specific;
      const name = s?.name ?? (rule && !matchCategory(cats, rule) ? rule : undefined);
      const have = name ? matchCategory(cats, name) : null;
      if (have) {
        category = have.name;
        how = "regra";
      } else if (name) {
        category = name;
        how = "nova" as typeof how;
        if (!suggested.has(name)) suggested.set(name, { name, kind: s?.name === name ? s.kind : kind, keywords: s?.name === name ? s.keywords : [], color: CATEGORY_PALETTE[(cats.length + suggested.size) % CATEGORY_PALETTE.length]! });
      }
    }
    const ref = refOf(st, t.ref);
    const day = Date.parse(t.date);
    const twin = mine.find((m) => !used.has(m.id) && m.kind === kind && Math.round(Number(m.amount) * 100) === Math.abs(t.cents) && Math.abs(Date.parse(m.day) - day) <= 3 * 86_400_000);
    if (twin) used.add(twin.id);
    rows.push({
      ref: t.ref,
      date: t.date,
      kind,
      amount,
      description: t.description,
      merchant: t.merchant,
      category,
      how,
      imported: done.has(ref),
      similar: twin && !done.has(ref) ? { id: twin.id, description: twin.description ?? twin.merchant ?? twin.category, date: twin.day } : null,
      skip: skipReason(text, t.cents, st.creditCard),
    });
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const live = rows.filter((r) => !r.imported && !r.skip);
  const sum = (k: string) => live.filter((r) => r.kind === k).reduce((s, r) => s + Math.round(r.amount * 100), 0) / 100;
  return {
    bank: st.bank,
    account: st.account ? `•••• ${st.account.replace(/\D/g, "").slice(-4) || st.account.slice(-4)}` : null,
    credit_card: st.creditCard,
    start: st.start ?? dates[0] ?? null,
    end: st.end ?? dates[dates.length - 1] ?? null,
    totals: { expenses: sum("expense"), income: sum("income"), count: rows.length, imported: rows.filter((r) => r.imported).length },
    suggested: [...suggested.values()].filter((s) => rows.some((r) => r.how === "nova" && r.category === s.name && !r.imported)),
    cards: st.creditCard ? (await listCards(userId)).map((c) => ({ id: c.id, name: c.name, color: c.color, last4: c.last4 ?? null })) : [],
    rows,
  };
}

export interface ImportChoice {
  ref: string;
  category: string;
  /** ela trocou a categoria sugerida: os próximos parecidos já vão para essa */
  changed?: boolean;
}

/** Importa as linhas escolhidas. Cria antes as categorias novas que ela aceitou. */
export async function importOfx(userId: string, input: { file: string; rows: ImportChoice[]; create?: { name: string; kind?: string; color?: string; keywords?: string[] }[]; card_id?: string | null; tz: string }) {
  const st = readOfx(input.file);
  const card = input.card_id ? await getCard(userId, input.card_id) : null;
  if (input.card_id && !card) throw new Error("Cartão não encontrado");
  let cats = await ensureCategories(userId);
  const created: string[] = [];
  for (const c of (input.create ?? []).slice(0, 10)) {
    if (matchCategory(cats, c.name)) continue;
    const row = await createCategory(userId, { name: c.name, kind: c.kind, color: c.color, keywords: c.keywords });
    created.push(row.name);
    cats = [...cats, { ...row }];
  }
  const byRef = new Map(st.transactions.map((t) => [t.ref, t]));
  let imported = 0;
  let skipped = 0;
  const learn: { kind: string; category: string; merchant: string | null; description: string }[] = [];
  for (const choice of input.rows.slice(0, 2000)) {
    const t = byRef.get(choice.ref);
    if (!t) continue;
    const kind = t.cents < 0 ? "expense" : "income";
    const category = matchCategory(cats, choice.category)?.name ?? FALLBACK;
    const r = await recordTransaction({
      userId,
      kind,
      total: Math.abs(t.cents) / 100,
      category,
      description: t.description,
      merchant: t.merchant,
      first: new Date(`${t.date}T12:00:00`),
      source: "ofx",
      ref: () => refOf(st, t.ref),
      card,
      tz: input.tz,
    });
    if (r.duplicate) skipped++;
    else imported++;
    if (choice.changed && !r.duplicate) learn.push({ kind, category, merchant: t.merchant, description: t.description });
  }
  if (learn.length) await learnCategory(userId, learn);
  return { imported, skipped, created };
}
