import { createCategory, deleteCategory, FALLBACK, listCategories, resolveCategory, updateCategory } from "../../categories.js";
import { brl } from "./finance.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

/** Categorias de gastos da pessoa pelo WhatsApp: ver, criar, renomear, trocar cor/palavras e excluir. */
export const categoriesTool = defineTool<{
  action: "list" | "create" | "edit" | "delete";
  name?: string;
  new_name?: string;
  color?: string;
  kind?: "expense" | "income" | "both";
  keywords?: string;
  move_to?: string;
  confirmed_by_user?: boolean;
}>({
  name: "categories",
  description:
    "Categorias de gastos dela. list; create (name, keywords opcionais: palavras que caem nela, ex. 'ração, veterinário, petshop'); " +
    "edit (name + new_name, color #RRGGBB, kind ou keywords; renomear leva os lançamentos junto); delete (move_to = para onde vão os lançamentos, padrão Outros).",
  parameters: obj(
    {
      action: { type: "string", enum: ["list", "create", "edit", "delete"] },
      name: { type: "string", description: "Categoria (create: o nome novo)" },
      new_name: { type: "string" },
      color: { type: "string" },
      kind: { type: "string", enum: ["expense", "income", "both"], description: "Padrão gasto" },
      keywords: { type: "string", description: "Separadas por vírgula; em edit substitui as de antes" },
      move_to: { type: "string" },
      ...CONFIRM_PARAM,
    },
    ["action"],
  ),
  async run(args, ctx) {
    try {
      if (args.action === "list") {
        const cats = await listCategories(ctx.user.id, ctx.timezone);
        return {
          categories: cats.map((c) => ({
            name: c.name,
            ...(c.kind !== "expense" ? { kind: c.kind === "income" ? "receita" : "gasto e receita" } : {}),
            ...(c.keywords.length ? { keywords: c.keywords.join(", ") } : {}),
            ...(c.month_total ? { this_month: brl(Math.round(c.month_total * 100) / 100) } : {}),
          })),
        };
      }
      if (!args.name?.trim()) return { ok: false, error: "Diga qual categoria" };
      if (args.action === "create") {
        const c = await createCategory(ctx.user.id, { name: args.name, color: args.color, kind: args.kind, keywords: args.keywords });
        return { ok: true, created: c.name, ...(c.keywords.length ? { keywords: c.keywords.join(", ") } : {}) };
      }
      if (args.action === "edit") {
        const c = await updateCategory(ctx.user.id, args.name, {
          name: args.new_name,
          color: args.color,
          kind: args.kind,
          ...(args.keywords !== undefined ? { keywords: args.keywords } : {}),
        });
        return { ok: true, category: c.name, ...(c.old_name ? { renamed_from: c.old_name, moved: c.moved } : {}), ...(c.keywords.length ? { keywords: c.keywords.join(", ") } : {}) };
      }
      const c = await resolveCategory(ctx.user.id, args.name);
      if (!c) return { ok: false, error: `Não achei a categoria "${args.name}"` };
      if (c.name === FALLBACK) return { ok: false, error: `${FALLBACK} não pode ser excluída: é para onde vai o que não tem categoria` };
      if (args.move_to?.trim() && !(await resolveCategory(ctx.user.id, args.move_to))) return { ok: false, error: `Não achei a categoria "${args.move_to}" para mandar os lançamentos` };
      const n = (await listCategories(ctx.user.id, ctx.timezone)).find((x) => x.id === c.id)?.count ?? 0;
      // sem lançamentos não mexe em nada dela: sai direto; com lançamentos, só depois do sim
      if (n > 0) {
        const gate = await requireConfirmation(args, `excluir a categoria ${c.name} e passar ${n} lançamento(s) para ${args.move_to?.trim() || "Outros"}`, ctx);
        if (gate) return { ...gate, count: n };
      }
      return { ok: true, ...(await deleteCategory(ctx.user.id, c.id, args.move_to)) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
});
