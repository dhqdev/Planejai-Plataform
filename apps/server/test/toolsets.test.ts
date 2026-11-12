import { describe, expect, it } from "vitest";
import { ctoGroups, CTO_TOOL_GROUPS, CTO_TOOLS, SPECIALISTS, TEAM_TOOLS_WHEN } from "../src/agent/team.js";
import { UBER_TOOLS } from "../src/agent/tools/uber.js";

const ids = (t: string) => ctoGroups(t).map((g) => g.id);

describe("ferramentas do CTO por assunto", () => {
  it("mensagem comum não carrega grupo nenhum", () => {
    for (const t of ["quanto gastei com mercado esse mês?", "gastei 30 no almoço", "me lembra de pagar a luz amanhã às 9", "qual o petshop mais perto?", "bom dia!"]) {
      expect(ids(t), t).toEqual([]);
    }
  });

  it("o assunto traz o grupo certo", () => {
    expect(ids("manda pro João que eu chego às 8")).toContain("mensagens");
    expect(ids("fala pra ele que topo")).toContain("mensagens");
    expect(ids("*Giovani* te mandou pelo Planejai: bora?")).toContain("mensagens");
    expect(ids("avisa a Ana às 7h que a reunião mudou")).toContain("mensagens");
    expect(ids("me faz um PDF com o resumo do livro")).toContain("midia");
    expect(ids("me manda um áudio contando uma história")).toContain("midia");
    expect(ids("cria uma imagem de um gato astronauta")).toContain("midia");
    expect(ids("libera minhas finanças pro Giovani")).toContain("contatos");
    expect(ids("tira o Giovani da minha agenda")).toContain("contatos");
    expect(ids("para de ficar de olho no iphone")).toContain("acompanhamentos");
    expect(ids("no máximo 600 com restaurante")).toContain("dinheiro");
    expect(ids("paguei a fatura do nubank")).toContain("dinheiro");
    expect(ids("apaga o documento do contrato")).toContain("documentos");
    for (const t of ["responde o Pedro que topo", "pergunta pro João se ele vem", "encaminha isso pro Carlos", "repassa pra Ana o endereço"]) expect(ids(t), t).toContain("mensagens");
    expect(ids("quero ver meus cartões")).toContain("dinheiro");
    expect(ids("gastei 50 dólares no almoço")).toContain("dolar");
    expect(ids("quanto é 100 dólares em reais?")).toContain("dolar");
    expect(TEAM_TOOLS_WHEN.test("cria um agente pra cuidar do meu treino")).toBe(true);
    expect(TEAM_TOOLS_WHEN.test("quanto tá o dólar?")).toBe(false);
  });

  it("toda ferramenta que sai do CTO tem um especialista que também faz (ou é do próprio CTO)", () => {
    const core = new Set(CTO_TOOLS.map((t) => t.name));
    const team = new Set(SPECIALISTS.flatMap((s) => s.tools.map((t) => t.name)));
    // make_audio e send_gif não têm especialista: o grupo de mídia pega "áudio" e "gif" pela palavra
    // unsend_message apaga mensagem do próprio CTO na conversa: não tem por que passar por especialista
    // Uber (beta) é só do CTO: enfileira e a resposta chega sozinha, não tem o que um especialista somar
    // reunião pelo link: a Marlene é da loja (não está em SPECIALISTS), então o CTO também manda ela entrar e sair
    const own = new Set(["make_audio", "send_gif", "document_delete", "unsend_message", "meeting_join", "meeting_leave", "meeting_list", ...UBER_TOOLS.map((t) => t.name)]);
    for (const t of CTO_TOOL_GROUPS.flatMap((g) => g.tools)) {
      expect(core.has(t.name), `${t.name} não pode estar no núcleo e num grupo`).toBe(false);
      expect(team.has(t.name) || own.has(t.name), `${t.name} sem especialista`).toBe(true);
    }
  });

  it("Financeiro leva o núcleo sempre e o resto pelo assunto do pedido", async () => {
    const { byTopic } = await import("../src/agent/collab.js");
    const fin = SPECIALISTS.find((s) => s.id === "financeiro")!;
    const names = (text: string) => byTopic(fin, fin.tools, text).shown.map((t) => t.name);
    const plain = names("anotar gasto de R$ 8,20 na padaria");
    expect(plain).toContain("add_transaction");
    expect(plain).toContain("delete_transaction");
    expect(plain).not.toContain("card_save");
    expect(plain).not.toContain("bill_save");
    expect(names("compra de 1200 parcelada em 10x no Nubank")).toContain("card_list");
    expect(names("paguei o aluguel")).toContain("bill_pay");
    expect(names("guardei 200 na meta da viagem")).toContain("goal_add");
    expect(names("no máximo 600 com restaurante")).toContain("set_budget");
    // escondida continua rodando pelo nome
    expect(byTopic(fin, fin.tools, "padaria").hidden.map((t) => t.name)).toContain("card_invoice_pay");
  });
});
