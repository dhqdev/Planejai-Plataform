import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchQuick } from "../src/agent/quick.js";
import { searchCacheKey } from "../src/agent/cache.js";

/**
 * Economia de IA: atalhos sem IA para os pedidos mais comuns, busca compartilhada do dia,
 * reunião das 19h espaçada para quem conversa pouco e a loja de especialistas.
 */
describe("atalhos sem IA: só frase curta e inequívoca", () => {
  it("reconhece as perguntas comuns e deixa o resto para o time", () => {
    for (const t of [
      "quanto gastei esse mês?",
      "Quanto eu já gastei este mês",
      "qual o total de gastos do mês",
      "quanto gastei até agora",
    ])
      expect(matchQuick(t), t).toEqual({ kind: "gasto_mes" });
    expect(matchQuick("o que tenho amanhã?")).toEqual({
      kind: "agenda",
      day: 1,
    });
    expect(matchQuick("O que eu tenho pra hoje")).toEqual({
      kind: "agenda",
      day: 0,
    });
    expect(matchQuick("minha agenda de amanhã")).toEqual({
      kind: "agenda",
      day: 1,
    });
    expect(matchQuick("tenho algum compromisso hoje?")).toEqual({
      kind: "agenda",
      day: 0,
    });
    expect(matchQuick("apaga o último")).toEqual({
      kind: "apaga_ultimo",
      noun: false,
    });
    expect(matchQuick("apaga o último gasto")).toEqual({
      kind: "apaga_ultimo",
      noun: true,
    });
    for (const t of [
      "quanto gastei com mercado esse mês?",
      "quanto gastei mês passado",
      "o que tenho amanhã e quanto gastei?",
      "apaga o último lembrete",
      "apaga tudo",
      "quanto gastei",
    ])
      expect(matchQuick(t), t).toBeNull();
  });
});

describe("busca compartilhada do dia", () => {
  it("a mesma pergunta escrita de jeitos diferentes cai na mesma chave", () => {
    const a = searchCacheKey("Cotação do dólar hoje?");
    expect(searchCacheKey("dólar")).toEqual(a);
    expect(searchCacheKey("qual o valor do dolar agora")).toEqual(a);
    expect(a.ttl).toBe(1800);
    const w = searchCacheKey("previsão do tempo em Curitiba");
    expect(searchCacheKey("clima Curitiba")).toEqual(w);
    expect(w.ttl).toBe(3 * 3600);
    expect(searchCacheKey("cinema em Campinas").norm).not.toBe(
      searchCacheKey("teatro em Campinas").norm,
    );
    expect(searchCacheKey("voo São Paulo Rio").norm).not.toBe(
      searchCacheKey("voo Rio São Paulo").norm,
    );
  });
});

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const TZ = "America/Sao_Paulo";
let server: http.Server;
let llmCalls = 0;
let seq = 0;

describe.skipIf(!enabled)("economia de IA (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let channels: typeof import("../src/channels/index.js");
  let mod: typeof import("../src/agent/orchestrator.js");
  let ana: any;
  let conv: string;

  beforeAll(async () => {
    server = http
      .createServer((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
          llmCalls++;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              model: "fake/model",
              choices: [
                {
                  message: { role: "assistant", content: "resposta do time" },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                cost: 0.000001,
              },
            }),
          );
        });
      })
      .listen(4599);
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    channels = await import("../src/channels/index.js");
    mod = await import("../src/agent/orchestrator.js");
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    ana = await upsertUser("5511933334444", "Ana");
    await db.query(
      "UPDATE users SET status = 'active', timezone = $2 WHERE id = $1",
      [ana.id, TZ],
    );
    conv = (await upsertConversation(ana.id, "playground", "jid-ana-economia"))
      .id;
  });

  afterAll(async () => {
    server?.close();
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  async function say(text: string) {
    await db.query(
      "INSERT INTO messages (conversation_id, role, content, external_id, meta) VALUES ($1, 'user', $2, $3, $4)",
      [conv, text, `q${++seq}`, { kind: "text" }],
    );
    const channel = new channels.PlaygroundChannel();
    const before = llmCalls;
    const r = await mod.processConversation(conv, {
      trigger: "message",
      channel,
    });
    return {
      texts: channel.sent.filter((s) => s.type === "text").map((s) => s.text!),
      llm: llmCalls - before,
      executionId: r.executionId,
    };
  }

  it("quanto gastei esse mês: total e categorias direto do banco, sem chamar a IA", async () => {
    await db.query(
      `INSERT INTO transactions (user_id, kind, amount, category, description) VALUES
        ($1, 'expense', 100.50, 'Mercado', 'compras'), ($1, 'expense', 49.50, 'Transporte', 'uber'), ($1, 'income', 3000, 'Salário', 'salário')`,
      [ana.id],
    );
    const r = await say("quanto gastei esse mês?");
    expect(r.llm).toBe(0);
    expect(r.texts.join("\n")).toMatch(/gastou R\$ 150,00/);
    expect(r.texts.join("\n")).toMatch(
      /Mercado \(R\$ 100,50\) e Transporte \(R\$ 49,50\)/,
    );
    const step = await db.one(
      "SELECT name FROM execution_steps WHERE execution_id = $1 AND name LIKE 'atalho%'",
      [r.executionId],
    );
    expect(step.name).toBe("atalho sem IA: gasto_mes");
  });

  it("o que tenho amanhã: lembretes do dia com hora, sem IA", async () => {
    const { isoLocal, parseLocalDateTime } = await import("../src/time.js");
    const tomorrow = isoLocal(new Date(Date.now() + 86_400_000), TZ).slice(
      0,
      10,
    );
    await db.query(
      "INSERT INTO reminders (user_id, conversation_id, intent, title, due_at, timezone) VALUES ($1, $2, 'dentista', 'Dentista', $3, $4)",
      [ana.id, conv, parseLocalDateTime(`${tomorrow}T09:30`, TZ), TZ],
    );
    const r = await say("o que tenho amanhã?");
    expect(r.llm).toBe(0);
    expect(r.texts.join("\n")).toMatch(/9h30 Dentista/);
  });

  it("apaga o último: tira o lançamento recente; se um lembrete foi criado depois, quem decide é o time", async () => {
    await db.query(
      "INSERT INTO transactions (user_id, kind, amount, category, description) VALUES ($1, 'expense', 12, 'Lazer', 'sorvete')",
      [ana.id],
    );
    const r = await say("apaga o último");
    expect(r.llm).toBe(0);
    expect(r.texts.join("\n")).toMatch(/apaguei o gasto sorvete de R\$ 12,00/);
    expect(
      await db.one("SELECT id FROM transactions WHERE description = 'sorvete'"),
    ).toBeUndefined();

    await db.query(
      "INSERT INTO transactions (user_id, kind, amount, category, description, created_at) VALUES ($1, 'expense', 8, 'Lazer', 'pipoca', now() - interval '1 minute')",
      [ana.id],
    );
    await db.query(
      "INSERT INTO reminders (user_id, conversation_id, intent, due_at, timezone) VALUES ($1, $2, 'ligar pra mãe', now() + interval '1 day', $3)",
      [ana.id, conv, TZ],
    );
    const r2 = await say("apaga o último");
    expect(r2.llm).toBeGreaterThan(0);
    expect(
      await db.one("SELECT id FROM transactions WHERE description = 'pipoca'"),
    ).toBeTruthy();
  });

  it("pergunta parecida mas diferente vai para o time", async () => {
    const r = await say("quanto gastei com mercado esse mês?");
    expect(r.llm).toBeGreaterThan(0);
  });

  it("reunião das 19h: dia magro só a cada 3 dias; quem conversou bastante tem todo dia", async () => {
    const { upsertUser } = await import("../src/ingest.js");
    const leve = await upsertUser("5511922221111", "Leve");
    const forte = await upsertUser("5511922221112", "Forte");
    const novo = await upsertUser("5511922221113", "Novo");
    await db.query("UPDATE users SET status = 'active' WHERE id = ANY($1)", [
      [leve.id, forte.id, novo.id],
    ]);
    // ninguém mais conta nesta conta: só os três
    await db.query("DELETE FROM executions");
    await db.query("UPDATE users SET status = 'blocked' WHERE id = $1", [
      ana.id,
    ]);
    const execs = (id: string, n: number) =>
      db.query(
        "INSERT INTO executions (trigger, user_id, input, status) SELECT 'message', $1, 'oi', 'success' FROM generate_series(1, $2)",
        [id, n],
      );
    await execs(leve.id, 1);
    await execs(forte.id, 4);
    await execs(novo.id, 1);
    await db.query(
      "INSERT INTO improve_meetings (user_id, asks, created_at) VALUES ($1, 1, now() - interval '1 day'), ($2, 4, now() - interval '1 day')",
      [leve.id, forte.id],
    );
    const { dailyImprovement } = await import("../src/improve.js");
    // forte (4 pedidos) e novo (nunca teve reunião) entram; leve teve reunião ontem e conversou pouco
    expect((await dailyImprovement()).users).toBe(2);
    await db.query(
      "UPDATE improve_meetings SET created_at = now() - interval '3 days' WHERE user_id = $1",
      [leve.id],
    );
    expect((await dailyImprovement()).users).toBe(3);
    await db.query("UPDATE users SET status = 'active' WHERE id = $1", [
      ana.id,
    ]);
  });

  it("loja de especialistas: liga, vira agente do time, respeita o limite e desliga", async () => {
    const {
      STORE,
      activateStore,
      activeStoreAgents,
      deactivateStore,
      listStore,
    } = await import("../src/agent/store.js");
    const { CLIENT_AGENT_TOOLS, clientAgents, MAX_CLIENT_AGENTS } =
      await import("../src/agent/team.js");
    for (const s of STORE)
      for (const t of s.tools)
        expect(CLIENT_AGENT_TOOLS[t], `${s.slug}: ${t}`).toBeTruthy();

    expect(await activateStore(ana.id, "treino")).toEqual({ ok: true });
    expect(await activateStore(ana.id, "treino")).toEqual({ ok: true });
    const team = await clientAgents(ana.id);
    expect(team.map((a) => a.id)).toContain("c_treino");
    expect(
      team.find((a) => a.id === "c_treino")!.tools.map((t) => t.name),
    ).toContain("schedule_reminder");
    expect(await activeStoreAgents(ana.id)).toEqual([
      {
        slug: "treino",
        name: "Personal trainer",
        persona: "Valdirene",
        icon: "heart",
      },
    ]);
    expect(await activateStore(ana.id, "nao-existe")).toMatchObject({
      ok: false,
      status: 404,
    });

    // a reunião noturna não mexe nele (só nos que ela criou)
    expect(
      (
        await db.one(
          "SELECT origin FROM client_agents WHERE user_id = $1 AND slug = 'treino'",
          [ana.id],
        )
      ).origin,
    ).toBe("loja");

    for (const s of STORE.filter((x) => x.slug !== "treino").slice(
      0,
      MAX_CLIENT_AGENTS - 1,
    ))
      expect(await activateStore(ana.id, s.slug)).toEqual({ ok: true });
    const full = await listStore(ana.id);
    expect(full.used).toBe(MAX_CLIENT_AGENTS);
    const last = STORE.find(
      (s) => !full.items.find((i) => i.slug === s.slug)!.active,
    )!;
    expect(await activateStore(ana.id, last.slug)).toMatchObject({
      ok: false,
      status: 409,
    });

    expect(await deactivateStore(ana.id, "treino")).toBe(true);
    expect(await deactivateStore(ana.id, "treino")).toBe(false);
    expect((await clientAgents(ana.id)).map((a) => a.id)).not.toContain(
      "c_treino",
    );
  });

  describe("metas financeiras", () => {
    let user: any;
    beforeAll(async () => {
      const { upsertUser } = await import("../src/ingest.js");
      user = await upsertUser("5511955554444", "Meta");
      await db.query(
        "UPDATE users SET status = 'active', timezone = $2 WHERE id = $1",
        [user.id, TZ],
      );
    });

    it("quanto guardar por mês sai em centavos exatos, arredondado para cima", async () => {
      const { goalProgress } = await import("../src/goals.js");
      expect(
        goalProgress(
          { target: "2000.00", saved: "500.00", deadline: "2026-12-31" },
          "2026-10-12",
        ),
      ).toMatchObject({ left: 150000, pct: 25, months: 3, perMonth: 50000 });
      expect(
        goalProgress(
          { target: "100.00", saved: "0", deadline: "2026-12-01" },
          "2026-10-12",
        ),
      ).toMatchObject({ months: 2, perMonth: 5000 });
      expect(
        goalProgress(
          { target: "100.00", saved: "0", deadline: "2026-11-30" },
          "2026-10-12",
        ),
      ).toMatchObject({ months: 2, perMonth: 5000 });
      expect(
        goalProgress(
          { target: "10.00", saved: "0", deadline: "2026-12-31" },
          "2026-10-12",
        ).perMonth,
      ).toBe(334);
      expect(
        goalProgress(
          { target: "100.00", saved: "0", deadline: "2026-01-01" },
          "2026-10-12",
        ),
      ).toMatchObject({ months: 1, perMonth: 10000 });
    });

    it("o Moacir cria, guarda, tira e vê a meta; o resumo do mês traz as metas abertas", async () => {
      const tools = await import("../src/agent/tools/goals.js");
      const { financeSummary } = await import("../src/agent/tools/finance.js");
      const ctx: any = { user, timezone: TZ };
      const created: any = await tools.goalCreate.run(
        { title: "Viagem", target: "2.000,00", saved: 100 },
        ctx,
      );
      expect(created.goal).toMatchObject({
        title: "Viagem",
        saved: "R$ 100,00",
        left: "R$ 1.900,00",
        percent: "5%",
      });
      const added: any = await tools.goalMove.run(
        { title: "viagem", amount: 250.5 },
        ctx,
      );
      expect(added.goal.saved).toBe("R$ 350,50");
      await expect(
        tools.goalMove.run(
          { title: "Viagem", amount: 1000, withdraw: true },
          ctx,
        ),
      ).rejects.toThrow(/Só tem R\$ 350,50/);
      const out: any = await tools.goalMove.run(
        { title: "Viagem", amount: 50.5, withdraw: true },
        ctx,
      );
      expect(out.goal.saved).toBe("R$ 300,00");
      const sum: any = await financeSummary.run({}, ctx);
      expect(sum.goals.map((g: any) => g.title)).toEqual(["Viagem"]);
      // bateu a meta: fica concluída e sai do resumo
      await tools.goalMove.run({ title: "Viagem", amount: 1700 }, ctx);
      expect(
        ((await tools.goalList.run({}, ctx)) as any).goals[0],
      ).toMatchObject({ done: true, percent: "100%" });
      expect(
        ((await financeSummary.run({}, ctx)) as any).goals,
      ).toBeUndefined();
      const moves = await db.many(
        "SELECT amount FROM finance_goal_moves m JOIN finance_goals g ON g.id = m.goal_id WHERE g.user_id = $1 ORDER BY m.id",
        [user.id],
      );
      expect(moves.map((m) => Number(m.amount))).toEqual([
        100, 250.5, -50.5, 1700,
      ]);
      expect(
        (
          (await tools.goalUpdate.run(
            { title: "Viagem", remove: true },
            ctx,
          )) as any
        ).ok,
      ).toBe(true);
    });
  });
});
