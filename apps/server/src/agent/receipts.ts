import type { ChatMessage } from "../llm/types.js";
import { one } from "../db/pool.js";
import { formatLocal, isoLocal } from "../time.js";
import { addTransaction } from "./tools/finance.js";
import type { ToolContext } from "./tools/types.js";

/**
 * Foto ou PDF de comprovante vira despesa sem depender do modelo lembrar: a leitura da imagem já devolve a linha
 * "FINANCEIRO: tipo=comprovante; valor_total=...; data=...; estabelecimento=...; pago=..." (media.ts) e o servidor
 * lança na hora, com a categoria automática. O message_id é o mesmo que o CTO usaria, então nada duplica.
 */

export interface Receipt {
  tipo: string;
  valor: number;
  data: string | null;
  estabelecimento: string | null;
  pago: string;
  direcao: string;
}

/** Lê a linha FINANCEIRO de uma descrição; null se não for um comprovante único já pago. */
export function parseReceipt(text: string | null | undefined): Receipt | null {
  const line = String(text ?? "").match(/FINANCEIRO:([^\n]*)/i)?.[1];
  if (!line) return null;
  const kv: Record<string, string> = {};
  for (const part of line.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) kv[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  const tipo = (kv.tipo ?? "").toLowerCase();
  if (!/^(comprovante|nota|cupom|recibo|pix|boleto|fatura)$/.test(tipo)) return null;
  const pago = (kv.pago ?? "?").toLowerCase();
  // boleto e fatura só contam se já estão pagos; o resto (comprovante, nota) é pago por natureza, a não ser que diga "não"
  if (/^n[aã]o/.test(pago) || ((tipo === "boleto" || tipo === "fatura") && pago !== "sim")) return null;
  const valor = Number(String(kv.valor_total ?? "").replace(/[^\d.,]/g, "").replace(/,(?=\d{2}$)/, ".").replace(/,/g, ""));
  if (!Number.isFinite(valor) || valor <= 0) return null;
  const est = kv.estabelecimento && kv.estabelecimento !== "?" ? kv.estabelecimento.slice(0, 80) : null;
  return { tipo, valor, data: kv.data && kv.data !== "?" ? kv.data : null, estabelecimento: est, pago, direcao: (kv.direcao ?? "?").toLowerCase() };
}

/** "??-10-06" vira o ano atual (ou o passado, se cairia no futuro); "2026-10-06" fica. */
export function receiptDate(data: string | null, timezone: string, now = new Date()): string | undefined {
  if (!data) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(data)) return data;
  const m = data.match(/^\?{2,4}-(\d{2})-(\d{2})$/);
  if (!m) return undefined;
  const today = isoLocal(now, timezone).slice(0, 10);
  const year = Number(today.slice(0, 4));
  const guess = `${year}-${m[1]}-${m[2]}`;
  return guess > today ? `${year - 1}-${m[1]}-${m[2]}` : guess;
}

/** A pessoa pediu para não lançar ("não anota isso", "é só pra guardar"). */
const SKIP = /n[aã]o (lan[cç]|anot|registr|cont)|s[oó] (pra|para) guardar|guarda (esse|este|isso)/i;

export async function autoLaunchReceipts(pending: any[], ctx: ToolContext): Promise<ChatMessage[]> {
  const notes: ChatMessage[] = [];
  for (const m of pending) {
    if (m.role !== "user") continue;
    const kind = m.meta?.kind;
    const desc = kind === "image" ? m.meta?.image_description : kind === "document" ? String(m.meta?.doc_text ?? "").slice(0, 3000) : null;
    const r = parseReceipt(desc);
    if (!r || SKIP.test(m.content ?? "")) continue;
    // o mesmo Pix mandado de novo (ou como foto e depois PDF): mesmo valor e estabelecimento nos últimos 3 dias
    const twin = r.estabelecimento
      ? await one(
          `SELECT occurred_at FROM transactions WHERE user_id = $1 AND amount = $2 AND created_at > now() - interval '3 days'
             AND (merchant ILIKE $3 OR description ILIKE $3) AND (external_ref IS NULL OR external_ref NOT LIKE $4) LIMIT 1`,
          [ctx.user.id, r.valor, r.estabelecimento, `${m.id}:%`],
        )
      : null;
    if (twin) {
      const when = formatLocal(new Date(twin.occurred_at), ctx.timezone);
      const step = await ctx.tracer.step({ agent: "cto", type: "info", name: "comprovante repetido", input: { message_id: String(m.id), ...r } });
      await step.ok({ lancado: false, parecido_com: when });
      notes.push({ role: "system", content: `O comprovante da msg_id=${m.id} parece o mesmo comprovante de ${when} e não foi lançado; pergunte se é outro.` });
      continue;
    }
    // pagamento da fatura de um cartão acompanhado: as compras já estão lançadas, então não vira gasto de novo
    const invoiceCard = await invoicePayment(ctx.user.id, r, desc ?? "", ctx.timezone);
    if (invoiceCard) {
      const step = await ctx.tracer.step({ agent: "cto", type: "info", name: "comprovante de fatura", input: { message_id: String(m.id), ...r } });
      await step.ok({ lancado: false, cartao: invoiceCard });
      notes.push({
        role: "system",
        content:
          `O comprovante da msg_id=${m.id} (${r.valor.toFixed(2)}) parece o pagamento da fatura do cartão ${invoiceCard}, e NÃO foi lançado como gasto: as compras desse cartão já estão lançadas. ` +
          `Se for isso, chame card_invoice_pay (card="${invoiceCard}", amount=${r.valor}) e conte em uma frase. Se não for pagamento de fatura, lance com add_transaction e message_id=${m.id}.`,
      });
      continue;
    }
    const step = await ctx.tracer.step({ agent: "cto", type: "tool", name: "add_transaction", input: { automatico: "comprovante na foto", message_id: String(m.id), ...r } });
    try {
      const out: any = await addTransaction.run(
        {
          kind: /^entrada|receb/.test(r.direcao) ? "income" : "expense",
          amount: r.valor,
          description: r.estabelecimento ?? r.tipo,
          merchant: r.estabelecimento ?? undefined,
          date: receiptDate(r.data, ctx.timezone),
          source: kind === "document" ? "documento" : "comprovante",
          message_id: String(m.id),
        },
        { ...ctx, parentStepId: step.id },
      );
      await step.ok(out);
      if (!out?.ok) {
        // data estranha ou valor inválido: o CTO resolve com a pessoa
        notes.push({ role: "system", content: `O comprovante da msg_id=${m.id} não foi lançado sozinho (${out?.error ?? "erro"}). Resolva com add_transaction ou pergunte o que faltar.` });
        continue;
      }
      ctx.room.done.add("add_transaction");
      notes.push({
        role: "system",
        content: out.duplicate
          ? `O comprovante da msg_id=${m.id} já estava lançado antes; nada foi duplicado. Não chame add_transaction para ele.`
          : `O sistema JÁ lançou o comprovante da msg_id=${m.id}: ${JSON.stringify(out).slice(0, 600)}. Não chame add_transaction para ele de novo. ` +
            "Confirme em uma frase curta (valor, categoria e o total do mês na categoria) e troque a reação por ✅. Se a pessoa pediu outra coisa junto, faça também; se a categoria estiver errada, corrija com update_transaction.",
      });
    } catch (err) {
      await step.fail(err);
    }
  }
  return notes;
}

/**
 * Nome do cartão se o comprovante parece pagar a fatura dele: tipo fatura, texto falando em fatura/cartão,
 * ou valor batendo (até R$ 1) com uma fatura fechada e não paga. Só cartões com compras lançadas.
 */
async function invoicePayment(userId: string, r: Receipt, text: string, tz: string): Promise<string | null> {
  if (/^entrada|receb/.test(r.direcao)) return null;
  const { cardsPaidBy, listCards } = await import("../cards.js");
  const cards = await cardsPaidBy(userId, `${r.tipo === "fatura" ? "fatura " : ""}${r.estabelecimento ?? ""} ${/fatura|cart[aã]o de cr[eé]dito/i.test(text) ? "fatura" : ""}`);
  if (cards.length !== 1) return null;
  const c = cards[0]!;
  if (r.tipo === "fatura" || /fatura|cart[aã]o de cr[eé]dito/i.test(text)) return c.name;
  const s = (await listCards(userId, tz)).find((x) => x.id === c.id);
  const open = (s?.invoices ?? []).filter((i) => i.status === "fechada" || i.status === "atrasada" || i.month === s?.next.month);
  return open.some((i) => Math.abs(i.total - r.valor) <= 1) ? c.name : null;
}
