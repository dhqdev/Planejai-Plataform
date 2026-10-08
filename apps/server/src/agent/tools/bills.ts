import { brl, CATEGORIES } from "./finance.js";
import { createBill, deleteBill, findBill, listBills, payBill, updateBill } from "../../bills.js";
import { defineTool, obj } from "./types.js";

/** Ferramentas de contas fixas (aluguel, internet, parcelas, salário): lembrete antes do vencimento e "paguei" lança no mês. */

const pick = async (userId: string, args: { id?: string; name?: string }) => {
  if (args.id) return args.id;
  if (!args.name?.trim()) throw new Error("Diga qual conta (id ou nome)");
  const found = await findBill(userId, args.name);
  if (!found.length) throw new Error(`Não achei conta fixa com "${args.name}"`);
  if (found.length > 1 && found[0]!.description.toLowerCase() !== args.name.trim().toLowerCase())
    throw new Error(`Mais de uma conta parecida: ${found.map((b) => b.description).join(", ")}. Qual delas?`);
  return found[0]!.id;
};

export const billSave = defineTool<{
  id?: string;
  name?: string;
  description?: string;
  kind?: "expense" | "income";
  amount?: number | null;
  category?: string;
  due_day?: number;
  remind_days_before?: number;
  installments_left?: number | null;
}>({
  name: "bill_save",
  description:
    "Cria ou ajusta uma conta fixa do mês (aluguel, internet, luz, parcela, salário que cai todo mês). O sistema lembra sozinho antes do vencimento " +
    "e no dia, e pergunta no dia seguinte se não foi paga. Sem id/name cria; com id ou name ajusta. amount vazio = valor muda todo mês. " +
    "installments_left = parcelas que faltam (encerra sozinha no fim).",
  parameters: obj(
    {
      id: { type: "string", description: "Para ajustar uma existente" },
      name: { type: "string", description: "Nome de uma existente para ajustar" },
      description: { type: "string", description: "Nome da conta (ex.: Aluguel, Parcela do carro)" },
      kind: { type: "string", enum: ["expense", "income"] },
      amount: { type: "number", description: "Valor fixo em reais; omita se varia" },
      category: { type: "string", enum: CATEGORIES },
      due_day: { type: "number", description: "Dia do vencimento (1 a 31)" },
      remind_days_before: { type: "number", description: "Quantos dias antes lembrar (padrão 1; 0 = só no dia)" },
      installments_left: { type: "number", description: "Parcelas que faltam" },
    },
    [],
  ),
  async run(args, ctx) {
    const { id: _id, name, ...input } = args;
    if (args.id || name) {
      const id = await pick(ctx.user.id, args);
      const b = await updateBill(ctx.user.id, id, input);
      if (!b) return { ok: false, error: "Conta não encontrada" };
      return { ok: true, updated: b.description, due_day: b.due_day, amount: b.amount != null ? brl(Number(b.amount)) : "varia" };
    }
    const b = await createBill(ctx.user.id, input);
    return { ok: true, id: b!.id, created: b!.description, due_day: b!.due_day, amount: b!.amount != null ? brl(Number(b!.amount)) : "varia", remind_days_before: b!.remind_days_before };
  },
});

export const billList = defineTool<Record<string, never>>({
  name: "bill_list",
  description: "Lista as contas fixas da pessoa com o vencimento e se já foram pagas neste mês.",
  parameters: obj({}),
  async run(_a, ctx) {
    const rows = await listBills(ctx.user.id, ctx.timezone);
    if (!rows.length) return { bills: [], note: "Nenhuma conta fixa cadastrada." };
    return {
      bills: rows.map((b) => ({
        id: b.id,
        name: b.description,
        kind: b.kind,
        amount: b.amount != null ? brl(b.amount) : "varia",
        due_day: b.due_day,
        status: b.status.paid ? "paga este mês" : b.status.late ? `atrasada ${-b.status.days} dia(s)` : `vence em ${b.status.days} dia(s)`,
        installments_left: b.installments_left,
      })),
    };
  },
});

export const billPay = defineTool<{ id?: string; name?: string; amount?: number }>({
  name: "bill_pay",
  description: "Marca uma conta fixa como paga (ou recebida) neste mês e lança o valor nas finanças. Use quando a pessoa disser 'paguei o aluguel'. Conta de valor variável precisa de amount.",
  parameters: obj({ id: { type: "string" }, name: { type: "string" }, amount: { type: "number", description: "Valor pago, se diferente ou se a conta varia" } }, []),
  async run(args, ctx) {
    const id = await pick(ctx.user.id, args);
    const r = await payBill(ctx.user.id, id, { amount: args.amount, tz: ctx.timezone });
    if (r.already) return { ok: true, already_paid: true, name: r.bill.description };
    ctx.room?.done.add("add_transaction");
    return { ok: true, name: r.bill.description, launched: brl(Number(r.transaction?.amount ?? 0)), installments_left: r.installments_left ?? undefined, finished: r.bill.active === false };
  },
});

export const billDelete = defineTool<{ id?: string; name?: string }>({
  name: "bill_delete",
  description: "Para de acompanhar uma conta fixa (não apaga lançamentos já feitos).",
  parameters: obj({ id: { type: "string" }, name: { type: "string" } }, []),
  async run(args, ctx) {
    const id = await pick(ctx.user.id, args);
    return { ok: await deleteBill(ctx.user.id, id) };
  },
});
