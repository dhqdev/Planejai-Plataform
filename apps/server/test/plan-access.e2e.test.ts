import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Planos por recurso (2026-10-20): Leve = Juvenal sozinho com gastos e agenda; Dia a dia = time + 2 da loja; Completo = tudo. */
describe("planos por recurso: regras sem banco", () => {
  it("cada plano padrão tem o seu nível; plano novo sem escolha fica no time; o painel salva o nível", async () => {
    const { cleanPlans, DEFAULT_PLANS, levelOf } = await import("../src/settings.js");
    expect(DEFAULT_PLANS.map(levelOf)).toEqual(["basico", "time", "completo"]);
    expect(DEFAULT_PLANS[0]!.grains).toBe(2500);
    expect(levelOf({ id: "leve", name: "Leve", price: 10, grains: 10, blurb: "" })).toBe("basico");
    expect(levelOf({ id: "familia", name: "Família", price: 10, grains: 10, blurb: "" })).toBe("time");
    expect(cleanPlans([{ name: "Família", price: 50, grains: 5000, level: "completo" }])[0]!.level).toBe("completo");
    expect(cleanPlans([{ name: "Família", price: 50, grains: 5000, level: "vip" }])[0]!.level).toBeUndefined();
  });

  it("no básico o Juvenal só tem gastos e agenda, mesmo pedindo outra coisa", async () => {
    const { basicTools } = await import("../src/agent/team.js");
    const names = (t: string) => {
      const r = basicTools(t);
      return { tools: r.tools.map((x) => x.name), hidden: r.hidden.map((x) => x.name) };
    };
    const comum = names("gastei 30 no mercado");
    expect(comum.tools).toEqual(expect.arrayContaining(["add_transaction", "finance_summary", "schedule_reminder", "calendar_create_event"]));
    for (const t of ["pesquisa um voo pra recife", "manda pro João que eu chego às 8", "faz um PDF do resumo", "fica de olho no preço do iphone"]) {
      const all = [...names(t).tools, ...names(t).hidden];
      for (const proibida of ["web_search", "send_to_contact", "send_whatsapp", "make_pdf", "make_image", "watch_create", "conversa_start", "make_chart", "create_payment_link"]) {
        expect(all, `${t}: ${proibida}`).not.toContain(proibida);
      }
    }
    // cartão e conta fixa entram pelo assunto; fora dele ficam escondidas (rodam pelo nome, todas liberadas)
    expect(names("comprei no cartão nubank em 3x").tools).toContain("card_list");
    expect(names("gastei 30 no mercado").tools).not.toContain("card_list");
    expect(names("gastei 30 no mercado").hidden).toContain("card_list");
    expect(names("paguei o aluguel").tools).toContain("bill_pay");
  });

  it("agentes da pessoa por plano: nenhum no básico, 2 da loja no time (sem a Secretária), todos no Completo", async () => {
    const { accessFor, allowedClientRows } = await import("../src/plan-access.js");
    const rows = [
      { slug: "meu", origin: "pedido" },
      { slug: "reunioes", origin: "loja" },
      { slug: "treino", origin: "loja" },
      { slug: "pet", origin: "loja" },
      { slug: "estudos", origin: "loja" },
    ];
    expect(allowedClientRows(rows, accessFor("basico"))).toEqual([]);
    expect(allowedClientRows(rows, accessFor("time")).map((r) => r.slug)).toEqual(["treino", "pet"]);
    expect(allowedClientRows(rows, accessFor("completo"))).toHaveLength(5);
  });
});

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("planos por recurso (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let settings: typeof import("../src/settings.js");
  let access: typeof import("../src/plan-access.js");
  let store: typeof import("../src/agent/store.js");
  let user: any;
  const reload = async () => (user = await db.one("SELECT * FROM users WHERE id = $1", [user.id]));
  const setPlan = (planId: string | null) =>
    db.query(
      `INSERT INTO subscriptions (user_id, asaas_customer_id, asaas_subscription_id, status, value, plan_id) VALUES ($1, 'cus_x', $2, 'active', 10, $3)
       ON CONFLICT (user_id) DO UPDATE SET asaas_subscription_id = $2, status = $4, plan_id = $3`,
      [user.id, planId ? "sub_x" : null, planId, planId ? "active" : "canceled"],
    );

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    settings = await import("../src/settings.js");
    access = await import("../src/plan-access.js");
    store = await import("../src/agent/store.js");
    const { upsertUser } = await import("../src/ingest.js");
    user = await upsertUser("5519955550000", "Lia");
    await db.query("UPDATE users SET status = 'active', created_at = now() - interval '30 days' WHERE id = $1", [user.id]);
    await reload();
  });

  afterAll(async () => {
    await (await import("../src/shortmem.js")).closeShort().catch(() => {});
    await (await import("../src/queue/boss.js")).stopBoss().catch(() => {});
    await db?.pool.end();
  });

  it("cobrança desligada ou período livre: tudo liberado; depois, pelo plano", async () => {
    expect((await access.planAccess(user)).level).toBe("completo");
    await settings.saveSettings({ billingEnabled: true, billingTrialDays: 3 });
    // nunca pagou e sem plano: básico
    expect((await access.planAccess(user)).level).toBe("basico");
    await db.query("UPDATE users SET created_at = now() WHERE id = $1", [user.id]);
    await reload();
    expect((await access.planAccess(user)).level).toBe("completo");
    await db.query("UPDATE users SET created_at = now() - interval '30 days' WHERE id = $1", [user.id]);
    await reload();
    await setPlan("leve");
    expect((await access.planAccess(user)).level).toBe("basico");
    await setPlan("dia-a-dia");
    expect((await access.planAccess(user)).level).toBe("time");
    await setPlan("completo");
    expect((await access.planAccess(user)).level).toBe("completo");
  });

  it("loja: o Leve não liga ninguém, o Dia a dia liga 2 e a Secretária só no Completo", async () => {
    await setPlan("leve");
    const leve = await store.activateStore(user.id, "treino");
    expect(leve).toMatchObject({ ok: false, status: 402 });
    expect((await store.listStore(user.id)).items.find((i) => i.slug === "treino")?.locked).toBe("Dia a dia");

    await setPlan("dia-a-dia");
    expect(await store.activateStore(user.id, "treino")).toEqual({ ok: true });
    expect(await store.activateStore(user.id, "reunioes")).toMatchObject({ ok: false, status: 402 });
    expect(await store.activateStore(user.id, "pet")).toEqual({ ok: true });
    expect(await store.activateStore(user.id, "estudos")).toMatchObject({ ok: false, status: 402 });
    const list = await store.listStore(user.id);
    expect(list.plan).toMatchObject({ level: "time", storeMax: 2, storeUsed: 2, upgrade: "Completo" });
    expect(list.items.find((i) => i.slug === "estudos")?.locked).toBe("Completo");

    // desceu para o Leve: os ligados ficam guardados, mas pausados
    await setPlan("leve");
    const paused = await store.listStore(user.id);
    expect(paused.items.filter((i) => i.active).every((i) => i.paused)).toBe(true);
    const { clientAgents } = await import("../src/agent/team.js");
    expect(await clientAgents(user.id, await access.planAccess(user))).toEqual([]);
    expect(await clientAgents(user.id)).toHaveLength(2);
  });
});
