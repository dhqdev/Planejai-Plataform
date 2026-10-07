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
      [trig, { name: "H", type: "httpRequest", parameters: { url: "={{ $json.u }}" } }],
      [trig, { name: "H", type: "httpRequest", parameters: { url: "https://x.com", authentication: "predefinedCredentialType" } }],
      [{ name: "N", type: "noOp" }],
    ];
    for (const nodes of bad) await expect(buildWorkflow({ ...base, owner: false, nodes, connections: [] }), JSON.stringify(nodes)).rejects.toThrow();
    // o dono pode usar qualquer nó
    const wf = await buildWorkflow({ ...base, owner: true, nodes: [trig, { name: "C", type: "code", parameters: { jsCode: "return []" } }], connections: [{ from: "T", to: "C" }] });
    expect(wf.nodes[1]!.type).toBe("n8n-nodes-base.code");
  });

  it("webhook de cliente ganha prefixo próprio (não sequestra caminho de outro fluxo)", async () => {
    const { buildWorkflow } = await import("../src/agent/tools/automations.js");
    const wf = await buildWorkflow({ ...base, owner: false, nodes: [{ name: "W", type: "webhook", parameters: { path: "planejai-eventos" } }], connections: [] });
    expect((wf.nodes[0] as any).parameters.path).toBe("pj-11111111-planejai-eventos");
  });

  it("as ferramentas de automação ficam liberadas para clientes; o resto do n8n continua só do dono", async () => {
    const { isOwnerOnly } = await import("../src/agent/runner.js");
    const a = await import("../src/agent/tools/automations.js");
    const n = await import("../src/agent/tools/n8n.js");
    for (const t of [a.automationSave, a.automationList, a.automationManage]) expect(isOwnerOnly(t), t.name).toBe(false);
    for (const t of [n.n8nWorkflows, n.n8nTrigger]) expect(isOwnerOnly(t), t.name).toBe(true);
  });
});
