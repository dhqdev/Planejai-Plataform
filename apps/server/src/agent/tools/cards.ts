import { brl } from "./finance.js";
import {
  CARD_COLORS,
  createCard,
  defaultPayMonth,
  deleteCard,
  invoiceItems,
  listCards,
  looksLikeInvoiceOf,
  monthName,
  payInvoice,
  resolveCard,
  updateCard,
  type CardSummary,
  type Invoice,
} from "../../cards.js";
import { listBills } from "../../bills.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

/** Ferramentas de cartão de crédito e fatura. O cartão guarda só apelido, banco, final, limite, fechamento e vencimento. */

const br = (iso: string) => iso.split("-").reverse().join("/");
const STATUS: Record<string, string> = { aberta: "aberta", futura: "futura", fechada: "fechada, a pagar", atrasada: "vencida sem pagar", paga: "paga", zerada: "sem gastos" };
const inv = (i: Invoice) => ({ month: i.month, label: monthName(i.month), total: brl(i.total), closes: br(i.closing), due: br(i.due), status: STATUS[i.status] ?? i.status });
const MONTH = /^\d{4}-\d{2}$/;

function cardBrief(c: CardSummary) {
  return {
    id: c.id,
    name: c.name,
    ...(c.brand ? { brand: c.brand } : {}),
    ...(c.last4 ? { final: c.last4 } : {}),
    closes_day: c.closing_day,
    due_day: c.due_day,
    ...(c.limit != null ? { limit: brl(c.limit), used: brl(c.used), available: brl(c.available ?? 0) } : { used: brl(c.used) }),
    open_invoice: inv(c.open),
    ...(c.next.month !== c.open.month ? { next_to_pay: inv(c.next) } : {}),
    ...(c.installments.length ? { installments_running: c.installments.length } : {}),
  };
}

export const cardSave = defineTool<{
  card?: string;
  name?: string;
  brand?: string;
  last4?: string;
  limit?: number | string;
  closing_day?: number;
  due_day?: number;
  remind_days_before?: number;
  color?: string;
}>({
  name: "card_save",
  description:
    "Cadastra (sem card) ou ajusta (card = apelido/final de um existente) cartão de crédito: apelido, banco/bandeira, final de 4 dígitos, limite, dia de fechamento e de vencimento. " +
    "Nunca peça nem guarde número inteiro, CVV ou validade.",
  parameters: obj({
    card: { type: "string", description: "Cartão existente a ajustar" },
    name: { type: "string", description: "Apelido, ex.: Nubank" },
    brand: { type: "string", description: "Banco ou bandeira" },
    last4: { type: "string", description: "Só os 4 últimos dígitos" },
    limit: { type: "number" },
    closing_day: { type: "number", description: "Dia em que a fatura fecha" },
    due_day: { type: "number", description: "Dia em que a fatura vence" },
    remind_days_before: { type: "number", description: "Lembrar N dias antes do vencimento (padrão 3)" },
    color: { type: "string", enum: CARD_COLORS },
  }),
  async run(args, ctx) {
    const { card: which, ...input } = args;
    if (which?.trim()) {
      const found = await resolveCard(ctx.user.id, which);
      if ("error" in found) return { ok: false, error: found.error };
      const c = await updateCard(ctx.user.id, found.id, input);
      if (!c) return { ok: false, error: "Cartão não encontrado" };
      return { ok: true, updated: c.name, closes_day: c.closing_day, due_day: c.due_day, limit: c.limit_amount != null ? brl(c.limit_amount) : "sem limite informado" };
    }
    const c = await createCard(ctx.user.id, input);
    // a fatura desse cartão já era uma conta fixa: avisa para não lembrar nem lançar duas vezes
    const twins = (await listBills(ctx.user.id, ctx.timezone)).filter((b) => b.kind === "expense" && looksLikeInvoiceOf(c!, b.description));
    return {
      ...(twins.length
        ? {
            bill_twin: `Ela já tem a conta fixa "${twins[0]!.description}", que parece ser a fatura desse cartão. Pergunte se quer apagar (bill_delete) para não receber lembrete duplicado. Enquanto o cartão tiver compras lançadas, "paguei" nessa conta só marca a fatura como paga.`,
          }
        : {}),
      ok: true,
      created: c!.name,
      closes_day: c!.closing_day,
      due_day: c!.due_day,
      limit: c!.limit_amount != null ? brl(c!.limit_amount) : "sem limite informado",
      reminder: `aviso no WhatsApp quando a fatura fechar, ${c!.remind_days_before ? `${c!.remind_days_before} dia(s) antes e ` : ""}no dia do vencimento`,
    };
  },
});

export const cardList = defineTool<Record<string, never>>({
  name: "card_list",
  description: "Cartões da pessoa com limite usado e disponível, fatura aberta e a próxima a pagar.",
  parameters: obj({}),
  async run(_a, ctx) {
    const cards = await listCards(ctx.user.id, ctx.timezone);
    if (!cards.length) return { cards: [], note: "Nenhum cartão cadastrado." };
    return { cards: cards.map(cardBrief) };
  },
});

export const cardInvoice = defineTool<{ card?: string; month?: string; months?: number }>({
  name: "card_invoice",
  description:
    "Fatura do cartão: com card (e month AAAA-MM do vencimento, padrão a próxima a pagar) traz as compras; sem card, o valor de cada fatura mês a mês de todos os cartões e os parcelamentos em andamento.",
  parameters: obj({
    card: { type: "string" },
    month: { type: "string", description: "AAAA-MM do vencimento" },
    months: { type: "number", description: "Quantos meses à frente (padrão 6)" },
  }),
  async run(args, ctx) {
    const cards = await listCards(ctx.user.id, ctx.timezone);
    if (!cards.length) return { ok: false, error: "Ela ainda não tem cartão cadastrado (card_save)." };
    if (!args.card?.trim()) {
      const n = Math.min(Math.max(1, Math.floor(args.months ?? 6)), 24);
      return {
        cards: cards.map((c) => ({
          name: c.name,
          ...(c.available != null ? { available: brl(c.available) } : {}),
          invoices: c.invoices.filter((i) => i.month >= c.next.month).slice(0, n).map(inv),
          late: c.invoices.filter((i) => i.status === "atrasada").map(inv),
          installments: c.installments.slice(0, 15).map((p) => ({ what: p.description, part: brl(p.part), paid: `${p.paid}/${p.installments}`, left: brl(p.left_amount), ends: p.last_month ? monthName(p.last_month) : undefined })),
        })),
      };
    }
    const found = await resolveCard(ctx.user.id, args.card);
    if ("error" in found) return { ok: false, error: found.error };
    const sum = cards.find((c) => c.id === found.id)!;
    const month = args.month && MONTH.test(args.month) ? args.month : sum.next.month;
    const { invoice, items } = await invoiceItems(ctx.user.id, found, month, ctx.timezone);
    return {
      card: found.name,
      invoice: inv(invoice),
      ...(sum.available != null ? { available_limit: brl(sum.available) } : {}),
      count: items.length,
      items: items.slice(0, 40).map((t) => ({
        id: t.id,
        what: t.description ?? t.merchant ?? t.category,
        amount: `${t.kind === "income" ? "-" : ""}${brl(Number(t.amount))}`,
        bought: new Date(t.occurred_at).toLocaleDateString("pt-BR", { timeZone: ctx.timezone }),
      })),
      ...(items.length > 40 ? { note: `Mostrando 40 de ${items.length}.` } : {}),
    };
  },
});

export const cardInvoicePay = defineTool<{ card: string; month?: string; amount?: number }>({
  name: "card_invoice_pay",
  description: "Marca a fatura como paga ('paguei a fatura do Nubank'). Não lança gasto: as compras já estão lançadas. Sem month = a fatura fechada mais antiga ou a próxima.",
  parameters: obj({ card: { type: "string" }, month: { type: "string", description: "AAAA-MM do vencimento" }, amount: { type: "number", description: "Se pagou valor diferente do total" } }, ["card"]),
  async run(args, ctx) {
    const found = await resolveCard(ctx.user.id, args.card);
    if ("error" in found) return { ok: false, error: found.error };
    const month = args.month && MONTH.test(args.month) ? args.month : await defaultPayMonth(found, ctx.timezone);
    const r = await payInvoice(ctx.user.id, found, month, args.amount ?? null);
    return { ok: true, card: found.name, ...(r.already ? { already_paid: true } : {}), invoice: inv(r.invoice), ...(args.amount ? { paid: brl(Number(args.amount)) } : {}) };
  },
});

export const cardDelete = defineTool<{ card: string; confirmed_by_user?: boolean }>({
  name: "card_delete",
  description: "Remove um cartão (as compras continuam nos lançamentos). Pede o sim da pessoa.",
  parameters: obj({ card: { type: "string" }, ...CONFIRM_PARAM }, ["card"]),
  async run(args, ctx) {
    const found = await resolveCard(ctx.user.id, args.card);
    if ("error" in found) return { ok: false, error: found.error };
    const gate = await requireConfirmation(args, `remover o cartão ${found.name}${found.last4 ? ` (final ${found.last4})` : ""} (as compras continuam nos lançamentos)`, ctx);
    if (gate) return gate;
    return { ok: await deleteCard(ctx.user.id, found.id), removed: found.name };
  },
});
