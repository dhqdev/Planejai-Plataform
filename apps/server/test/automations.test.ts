import { describe, expect, it } from "vitest";

/** Automações no n8n criadas pelo assistente: o fluxo de cliente é seguro por construção. */
describe("automações no n8n", () => {
  const base = { userId: "11111111-2222-3333-4444-555555555555", webhookPrefix: "pj-11111111" };

  it("monta o fluxo no formato do n8n e o aviso sempre vai para a própria pessoa", async () => {
    const { buildWorkflow } = await import("../src/agent/tools/automations.js");
    const wf = await buildWorkflow({
      ...base,
      owner: false,
      nodes: [
        { name: "Todo dia 8h", type: "scheduleTrigger", parameters: { rule: { interval: [{ field: "cronExpression", expression: "0 8 * * *" }] } } },
        { name: "Notícias", type: "rssFeedRead", parameters: { url: "https://g1.globo.com/rss/g1/" } },
        { name: "Três", type: "limit", parameters: { maxItems: 3 } },
        { name: "Avisa", type: "planejai.agent", parameters: { instruction: "Resuma: {{ $json.title }}", user_id: "outra-pessoa" } },
      ],
      connections: [
        { from: "Todo dia 8h", to: "Notícias" },
        { from: "Notícias", to: "Três" },
        { from: "Três", to: "Avisa" },
      ],
    });
    expect(wf.nodes.map((n: any) => n.type)).toEqual([
      "n8n-nodes-base.scheduleTrigger",
      "n8n-nodes-base.rssFeedRead",
      "n8n-nodes-base.limit",
      "n8n-nodes-base.httpRequest",
    ]);
    const avisa: any = wf.nodes[3];
    expect(avisa.parameters.url).toBe("={{ $env.PLANEJAI_API_URL }}/api/internal/agent");
    expect(avisa.parameters.bodyParameters.parameters).toEqual([
      { name: "user_id", value: base.userId },
      { name: "instruction", value: "=Resuma: {{ $json.title }}" },
    ]);
    expect(wf.connections["Três"]!.main[0]).toEqual([{ node: "Avisa", type: "main", index: 0 }]);
  });

  it("recusa para cliente: código, segredos da instância, URL calculada e fluxo sem gatilho", async () => {
    const { buildWorkflow } = await import("../src/agent/tools/automations.js");
    const trig = { name: "T", type: "scheduleTrigger", parameters: {} };
    const bad = [
      [trig, { name: "C", type: "code", parameters: { jsCode: "return []" } }],
      [trig, { name: "S", type: "set", parameters: { value: "={{ $env.PLANEJAI_API_KEY }}" } }],
      // montar o nome da variável em pedaços não passa: só variáveis da lista entram
      [trig, { name: "A", type: "planejai.notify", parameters: { text: '{{ $evaluateExpression("{{ $"+"env.PLANEJAI_API_KEY }}") }}' } }],
      [trig, { name: "A", type: "planejai.agent", parameters: { instruction: "{{ this['$e'+'nv'] }}" } }],
      [trig, { name: "S", type: "set", parameters: { value: "={{ $workflow.id }} {{ $execution.id }}" } }],
      [trig, { name: "H", type: "httpRequest", parameters: { url: "={{ $json.u }}" } }],
      [trig, { name: "H", type: "httpRequest", parameters: { url: "https://x.com", authentication: "predefinedCredentialType" } }],
      [{ name: "N", type: "noOp" }],
    ];
    for (const nodes of bad) {
      // tudo ligado: a recusa é pelo conteúdo do nó, não por nó solto
      const connections = nodes.slice(1).map((n, i) => ({ from: nodes[i]!.name, to: n.name }));
      await expect(buildWorkflow({ ...base, owner: false, nodes, connections }), JSON.stringify(nodes)).rejects.toThrow();
    }
    // o que um fluxo comum de cliente usa continua valendo
    const ok = await buildWorkflow({
      ...base,
      owner: false,
      nodes: [trig, { name: "A", type: "planejai.agent", parameters: { instruction: "Resuma: {{ $json.title }} {{ $('T').item.json.x }} em {{ $now.toFormat('dd/MM') }}; custa R$ 10" } }],
      connections: [{ from: "T", to: "A" }],
    });
    expect(ok.nodes).toHaveLength(2);
    // o dono pode usar qualquer nó
    const wf = await buildWorkflow({ ...base, owner: true, nodes: [trig, { name: "C", type: "code", parameters: { jsCode: "return []" } }], connections: [{ from: "T", to: "C" }] });
    expect(wf.nodes[1]!.type).toBe("n8n-nodes-base.code");
  });

  it("webhook de cliente ganha prefixo próprio (não sequestra caminho de outro fluxo)", async () => {
    const { buildWorkflow } = await import("../src/agent/tools/automations.js");
    const wf = await buildWorkflow({
      ...base,
      owner: false,
      nodes: [
        { name: "W", type: "webhook", parameters: { path: "planejai-eventos" } },
        { name: "Avisa", type: "planejai.notify", parameters: { text: "chegou" } },
      ],
      connections: [{ from: "W", to: "Avisa" }],
    });
    expect((wf.nodes[0] as any).parameters.path).toBe("pj-11111111-planejai-eventos");
  });

  it("fluxo de cliente não dispara mais que a cada 15 minutos (cada disparo pode custar IA)", async () => {
    const { buildWorkflow, scheduleTooFrequent } = await import("../src/agent/tools/automations.js");
    const cron = (expression: string) => ({ rule: { interval: [{ field: "cronExpression", expression }] } });
    for (const ok of ["0 8 * * *", "30 9 * * 1-5", "*/15 * * * *", "0,30 * * * *", "0 0 8 * * *"]) expect(scheduleTooFrequent(cron(ok)), ok).toBeNull();
    for (const bad of ["* * * * *", "*/5 * * * *", "0-59 * * * *", "0,5,10 * * * *", "* 0 8 * * *", "0 8"]) expect(scheduleTooFrequent(cron(bad)), bad).not.toBeNull();
    expect(scheduleTooFrequent({ rule: { interval: [{ field: "hours", hoursInterval: 2 }] } })).toBeNull();
    expect(scheduleTooFrequent({ rule: { interval: [{ field: "minutes", minutesInterval: 30 }] } })).toBeNull();
    expect(scheduleTooFrequent({ rule: { interval: [{ field: "minutes", minutesInterval: 1 }] } })).not.toBeNull();
    expect(scheduleTooFrequent({ rule: { interval: [{ field: "seconds", secondsInterval: 30 }] } })).not.toBeNull();
    const nodes = [
      { name: "T", type: "scheduleTrigger", parameters: cron("* * * * *") },
      { name: "Avisa", type: "planejai.notify", parameters: { text: "oi" } },
    ];
    const connections = [{ from: "T", to: "Avisa" }];
    await expect(buildWorkflow({ ...base, owner: false, nodes, connections })).rejects.toThrow(/vezes demais/);
    // o dono decide a frequência dos fluxos dele
    await expect(buildWorkflow({ ...base, owner: true, nodes, connections })).resolves.toBeTruthy();
  });

  it("fluxo de cliente tem de estar inteiro ligado a partir do gatilho", async () => {
    const { buildWorkflow } = await import("../src/agent/tools/automations.js");
    const trig = { name: "T", type: "scheduleTrigger", parameters: {} };
    const avisa = { name: "Avisa", type: "planejai.notify", parameters: { text: "oi" } };
    await expect(buildWorkflow({ ...base, owner: false, nodes: [trig], connections: [] })).rejects.toThrow(/só tem o gatilho/);
    await expect(buildWorkflow({ ...base, owner: false, nodes: [trig, avisa], connections: [] })).rejects.toThrow(/sem ligação.*Avisa/);
    const solto = { name: "Solto", type: "noOp" };
    await expect(buildWorkflow({ ...base, owner: false, nodes: [trig, avisa, solto], connections: [{ from: "T", to: "Avisa" }] })).rejects.toThrow(/Solto/);
    // ramo falso do if também conta como ligado
    const se = { name: "Se", type: "if", parameters: {} };
    const wf = await buildWorkflow({
      ...base,
      owner: false,
      nodes: [trig, se, avisa, solto],
      connections: [{ from: "T", to: "Se" }, { from: "Se", to: "Avisa" }, { from: "Se", to: "Solto", output: 1 }],
    });
    expect(wf.connections["Se"]!.main).toHaveLength(2);
  });

  it("as ferramentas de automação ficam liberadas para clientes; o resto do n8n continua só do dono", async () => {
    const { isOwnerOnly } = await import("../src/agent/runner.js");
    const a = await import("../src/agent/tools/automations.js");
    const n = await import("../src/agent/tools/n8n.js");
    for (const t of [a.automationSave, a.automationList, a.automationManage, a.automationStatus]) expect(isOwnerOnly(t), t.name).toBe(false);
    for (const t of [n.n8nWorkflows, n.n8nTrigger]) expect(isOwnerOnly(t), t.name).toBe(true);
  });

  it("nome no n8n separa fluxo de cliente do fluxo do dono (os do sistema são [Sistema])", async () => {
    const { flowName } = await import("../src/agent/tools/automations.js");
    expect(flowName(false, "Maria", "Notícias às 8h")).toBe("[Cliente] Maria · Notícias às 8h");
    expect(flowName(true, "David", "Backup")).toBe("[Dono] Backup");
  });

  it("agente sob medida só ganha ferramentas seguras para qualquer pessoa, e o time dela conversa entre si", async () => {
    const { isOwnerOnly } = await import("../src/agent/runner.js");
    const { CLIENT_AGENT_TOOLS, SPECIALISTS, clientAgentDef, slugify } = await import("../src/agent/team.js");
    const { TeamRoom } = await import("../src/agent/collab.js");
    const { TEAM_TOOLS } = await import("../src/agent/tools/team.js");
    for (const t of Object.values(CLIENT_AGENT_TOOLS)) expect(isOwnerOnly(t) && !t.integration, t.name).toBe(false);
    // nada que mande mensagem a terceiros, mova dinheiro ou apague dados
    for (const n of ["gmail_send", "slack_send_message", "create_payment_link", "send_to_contact", "invite_person", "delete_transaction", "n8n_trigger", "automation_manage"])
      expect(n in CLIENT_AGENT_TOOLS, n).toBe(false);
    for (const t of TEAM_TOOLS) expect(isOwnerOnly(t), t.name).toBe(false);

    expect(slugify("Zé Viagem & Cia!")).toBe("ze_viagem_cia");
    const treino = clientAgentDef({ id: "x", slug: "treino", name: "Treino", persona: "Fit", face: null, focus: "treinos dela", instructions: "...", tools: ["web_search", "gmail_send", "schedule_reminder"] });
    expect(treino.id).toBe("c_treino");
    expect(treino.task).toBe("agent:cliente");
    expect(treino.tools.map((t) => t.name)).toEqual(["web_search", "schedule_reminder"]);

    const room = new TeamRoom([...SPECIALISTS, treino]);
    expect(room.nameOf("c_treino")).toBe("Treino");
    expect(room.nameOf("cto")).toBe("CTO");
    room.board.push({ from: "c_treino", note: "academia abre às 6h" });
    expect(room.boardText()).toContain("- Treino: academia abre às 6h");
    // a sala de uma execução não muda o time fixo
    room.team.push(clientAgentDef({ id: "y", slug: "dieta", name: "Dieta", focus: "f", instructions: "i", tools: [] }));
    expect(SPECIALISTS.some((s) => s.id.startsWith("c_"))).toBe(false);
  });
});
