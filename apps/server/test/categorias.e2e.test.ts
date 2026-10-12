import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { learnKey, matchCategory, type Category } from "../src/categories.js";

/**
 * Categorias de gastos de cada pessoa: criar, renomear, cor, palavras, excluir movendo os lançamentos,
 * e a categoria automática aprendendo com as correções (sem IA).
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);

const cat = (name: string, aliases: string[] = []): Category => ({ id: name, name, color: "#000000", kind: "expense", keywords: [], aliases, position: 0 });

describe("categorias: nome sem acento, plural e nome antigo", () => {
  it("acha a categoria do jeito que a pessoa ou o modelo escrever", () => {
    const cats = [cat("Alimentação"), cat("Pets", ["Bichos"]), cat("Outros")];
    expect(matchCategory(cats, "alimentacao")?.name).toBe("Alimentação");
    expect(matchCategory(cats, "PET")?.name).toBe("Pets");
    expect(matchCategory(cats, "bichos")?.name).toBe("Pets");
    expect(matchCategory(cats, "Lazer")).toBeNull();
    expect(learnKey("Uber Eats (2/10)")).toBe("uber eats");
    expect(learnKey("99")).toBeNull();
  });
});

describe.skipIf(!enabled)("categorias (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let fin: typeof import("../src/agent/tools/finance.js");
  let tool: typeof import("../src/agent/tools/categories.js").categoriesTool;
  let ctx: any;

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    const { upsertUser } = await import("../src/ingest.js");
    const user = await upsertUser("5519922221111", "Carla");
    await db.query("UPDATE users SET status = 'active' WHERE id = $1", [user.id]);
    ctx = { user, timezone: "America/Sao_Paulo" };
    fin = await import("../src/agent/tools/finance.js");
    tool = (await import("../src/agent/tools/categories.js")).categoriesTool;
  });

  afterAll(async () => {
    await db?.pool.end();
  });

  it("quem nunca mexeu tem as de sempre; cria uma nova com palavras e ela já pega os gastos", async () => {
    const list: any = await tool.run({ action: "list" }, ctx);
    expect(list.categories.map((c: any) => c.name)).toContain("Alimentação");
    expect(await tool.run({ action: "create", name: "Pets", keywords: "ração, veterinário, petshop" }, ctx)).toMatchObject({ ok: true, created: "Pets", keywords: "ração, veterinário, petshop" });
    expect(await tool.run({ action: "create", name: "pets" }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining("Já existe") });
    const a: any = await fin.addTransaction.run({ kind: "expense", amount: 120, description: "ração do Thor" }, ctx);
    expect(a.category).toBe("Pets");
    // o modelo pode mandar a categoria nova pelo nome, sem acento
    const b: any = await fin.addTransaction.run({ kind: "expense", amount: 90, description: "banho e tosa", category: "pet" }, ctx);
    expect(b.category).toBe("Pets");
  });

  it("aprende com a correção: o próximo parecido já vai para a categoria que ela escolheu", async () => {
    const a: any = await fin.addTransaction.run({ kind: "expense", amount: 45, description: "ifood", merchant: "iFood" }, ctx);
    expect(a.category).toBe("Alimentação");
    await tool.run({ action: "create", name: "Delivery" }, ctx);
    await fin.updateTransaction.run({ ids: a.ids, category: "delivery" }, ctx);
    const b: any = await fin.addTransaction.run({ kind: "expense", amount: 38, description: "janta", merchant: "IFOOD" }, ctx);
    expect(b.category).toBe("Delivery");
    // mesmo lugar dentro de outra frase também
    const c: any = await fin.addTransaction.run({ kind: "expense", amount: 22, description: "lanche no ifood" }, ctx);
    expect(c.category).toBe("Delivery");
    // categoria que ela não tem: não inventa, avisa
    const bad: any = await fin.updateTransaction.run({ ids: a.ids, category: "Bebidas" }, ctx);
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("não tem a categoria") });
    // não reconheceu nada: cai em Outros e o modelo sabe que pode ensinar
    const d: any = await fin.addTransaction.run({ kind: "expense", amount: 10, description: "xpto" }, ctx);
    expect(d).toMatchObject({ category: "Outros", category_note: expect.stringContaining("update_transaction") });
  });

  it("renomear leva lançamentos, limite e o aprendido; a regra antiga ainda acha pelo nome velho", async () => {
    await fin.setBudget.run({ category: "Alimentação", amount: 500 }, ctx);
    const r: any = await tool.run({ action: "edit", name: "alimentacao", new_name: "Comida", color: "#16a3a3" }, ctx);
    expect(r).toMatchObject({ ok: true, category: "Comida", renamed_from: "Alimentação" });
    expect(await db.one("SELECT COUNT(*)::int AS n FROM transactions WHERE user_id = $1 AND category = 'Alimentação'", [ctx.user.id])).toEqual({ n: 0 });
    expect(await db.one("SELECT category FROM budgets WHERE user_id = $1", [ctx.user.id])).toEqual({ category: "Comida" });
    expect(await db.one("SELECT color FROM finance_categories WHERE user_id = $1 AND name = 'Comida'", [ctx.user.id])).toEqual({ color: "#16A3A3" });
    const p: any = await fin.addTransaction.run({ kind: "expense", amount: 15, description: "pizza de domingo" }, ctx);
    expect(p.category).toBe("Comida");
    expect(await tool.run({ action: "edit", name: "Outros", new_name: "Diversos" }, ctx)).toMatchObject({ ok: false });
  });

  it("excluir com lançamentos pede o sim e manda tudo para a categoria escolhida", async () => {
    const ask: any = await tool.run({ action: "delete", name: "Delivery", move_to: "Comida" }, ctx);
    expect(ask).toMatchObject({ needs_confirmation: true, count: 3 });
    expect(await db.one("SELECT COUNT(*)::int AS n FROM finance_categories WHERE user_id = $1 AND name = 'Delivery'", [ctx.user.id])).toEqual({ n: 1 });
    const done: any = await tool.run({ action: "delete", name: "Delivery", move_to: "Comida" }, { ...ctx, approvedAction: true });
    expect(done).toMatchObject({ ok: true, deleted: "Delivery", moved_to: "Comida", moved: 3 });
    // o que era aprendido para Delivery agora vai para Comida
    const n: any = await fin.addTransaction.run({ kind: "expense", amount: 30, merchant: "iFood" }, ctx);
    expect(n.category).toBe("Comida");
    // vazia sai direto, sem pergunta
    await tool.run({ action: "create", name: "Teste" }, ctx);
    expect(await tool.run({ action: "delete", name: "Teste" }, ctx)).toMatchObject({ ok: true, moved: 0 });
    expect(await tool.run({ action: "delete", name: "Outros" }, ctx)).toMatchObject({ ok: false });
  });

  it("conta fixa usa as categorias dela", async () => {
    const { createBill } = await import("../src/bills.js");
    const b = await createBill(ctx.user.id, { description: "Plano do Thor", due_day: 5, category: "pets" });
    expect(b!.category).toBe("Pets");
    const l = await createBill(ctx.user.id, { description: "Aluguel", due_day: 10 });
    expect(l!.category).toBe("Moradia");
  });
});
