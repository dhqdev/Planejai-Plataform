import { describe, expect, it } from "vitest";

/** Automações no n8n: o assistente não cria fluxo, só cuida dos que já existem. */
describe("automações no n8n", () => {
  it("nenhum agente cria fluxo no n8n; listar, ligar/desligar e ver falha seguem liberados para clientes", async () => {
    const { isOwnerOnly } = await import("../src/agent/runner.js");
    const a = await import("../src/agent/tools/automations.js");
    const n = await import("../src/agent/tools/n8n.js");
    expect("automationSave" in a).toBe(false);
    for (const t of [a.automationList, a.automationManage, a.automationStatus]) expect(isOwnerOnly(t), t.name).toBe(false);
    for (const t of [n.n8nWorkflows, n.n8nTrigger]) expect(isOwnerOnly(t), t.name).toBe(true);
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
    for (const t of [...SPECIALISTS.flatMap((s) => s.tools), ...Object.values(CLIENT_AGENT_TOOLS)]) expect(t.name, "criar fluxo no n8n").not.toBe("automation_save");
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
