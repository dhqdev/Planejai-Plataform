import { createGoal, deleteGoal, describeGoal, findGoal, listGoals, moveGoal, updateGoal } from "../../goals.js";
import { defineTool, obj } from "./types.js";

/** Metas financeiras do Moacir: criar, guardar/tirar dinheiro, ver o progresso e quanto falta por mês. */

const pick = async (userId: string, args: { id?: string; title?: string }) => {
  const g = await findGoal(userId, args);
  if (!g) throw new Error(`Não achei meta com "${args.title ?? args.id}"`);
  return g;
};

export const goalCreate = defineTool<{ title: string; target: number | string; deadline?: string; saved?: number | string }>({
  name: "goal_create",
  description: "Cria uma meta financeira (ex.: juntar R$ 2.000 para viagem até dezembro). Devolve quanto guardar por mês se tiver prazo.",
  parameters: obj(
    {
      title: { type: "string", description: "Nome curto: Viagem, Reserva, Carro novo" },
      target: { type: "number", description: "Valor total da meta em reais" },
      deadline: { type: "string", description: "AAAA-MM-DD (opcional)" },
      saved: { type: "number", description: "Quanto já tem guardado (opcional)" },
    },
    ["title", "target"],
  ),
  async run(args, ctx) {
    return { ok: true, goal: describeGoal(await createGoal(ctx.user.id, args), ctx.timezone) };
  },
});

export const goalMove = defineTool<{ id?: string; title?: string; amount: number | string; withdraw?: boolean; note?: string }>({
  name: "goal_add",
  description: "Guarda dinheiro numa meta (\"guardei 200 na viagem\") ou tira (withdraw=true). Não é gasto: não lance add_transaction junto.",
  parameters: obj(
    {
      id: { type: "string" },
      title: { type: "string", description: "Nome da meta, se não tiver o id" },
      amount: { type: "number" },
      withdraw: { type: "boolean", description: "true = tirou dinheiro da meta" },
      note: { type: "string" },
    },
    ["amount"],
  ),
  async run(args, ctx) {
    const g = await pick(ctx.user.id, args);
    return { ok: true, goal: describeGoal(await moveGoal(ctx.user.id, g.id, args.amount, Boolean(args.withdraw), args.note), ctx.timezone) };
  },
});

export const goalList = defineTool<Record<string, never>>({
  name: "goal_list",
  description: "Metas financeiras da pessoa com progresso, quanto falta e quanto guardar por mês até o prazo.",
  parameters: obj({}),
  async run(_a, ctx) {
    const goals = await listGoals(ctx.user.id);
    return goals.length ? { goals: goals.map((g) => describeGoal(g, ctx.timezone)) } : { goals: [], note: "Nenhuma meta ainda." };
  },
});

export const goalUpdate = defineTool<{ id?: string; title?: string; new_title?: string; target?: number | string; deadline?: string | null; remove?: boolean }>({
  name: "goal_update",
  description: "Muda nome, valor ou prazo de uma meta, ou apaga (remove=true).",
  parameters: obj({
    id: { type: "string" },
    title: { type: "string", description: "Nome atual, se não tiver o id" },
    new_title: { type: "string" },
    target: { type: "number" },
    deadline: { type: "string", description: "AAAA-MM-DD; vazio tira o prazo" },
    remove: { type: "boolean" },
  }),
  async run(args, ctx) {
    const g = await pick(ctx.user.id, args);
    if (args.remove) return { ok: await deleteGoal(ctx.user.id, g.id), removed: g.title };
    const out = await updateGoal(ctx.user.id, g.id, { title: args.new_title, target: args.target, deadline: args.deadline === undefined ? undefined : args.deadline || null });
    return { ok: true, goal: describeGoal(out, ctx.timezone) };
  },
});

export const GOAL_TOOLS = [goalCreate, goalMove, goalList, goalUpdate];
