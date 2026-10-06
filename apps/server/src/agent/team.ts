import * as agenda from "./tools/agenda.js";
import * as comm from "./tools/communication.js";
import * as core from "./tools/core.js";
import * as finance from "./tools/finance.js";
import * as prod from "./tools/productivity.js";
import * as research from "./tools/research.js";
import type { Tool } from "./tools/types.js";

export interface AgentDef {
  id: string;
  name: string;
  emoji: string;
  /** descrição usada pelo CTO para decidir quando delegar */
  role: string;
  instructions: string;
  tools: Tool[];
}

/** Especialistas do time. Cada um tem ferramentas próprias e uma rota de modelo ("agent:<id>"). */
export const SPECIALISTS: AgentDef[] = [
  {
    id: "pesquisador",
    name: "Pesquisador",
    emoji: "🔎",
    role:
      "Pesquisa qualquer coisa atual na internet: sessões de cinema, preços e lojas, restaurantes, notícias, endereços, horários, " +
      "comparações de produtos. Abre páginas e tira print de páginas para mandar como foto.",
    instructions:
      "Pesquise em mais de uma fonte quando a resposta depender de dados atuais. Prefira sites oficiais (ex.: ingresso.com e sites dos cinemas, " +
      "lojas oficiais). Traga dados concretos (horários, preços, links). Se um print ajudar a pessoa (grade de sessões, cardápio, tabela), " +
      "use screenshot_url na página mais útil e informe o media_id no relatório. Diga claramente o que não conseguiu confirmar.",
    tools: [research.webSearch, research.fetchUrl, research.screenshotUrl, core.attachImage],
  },
  {
    id: "agenda",
    name: "Agenda",
    emoji: "📅",
    role: "Lembretes (únicos ou recorrentes), compromissos e Google Agenda: criar, listar, cancelar, ver o que tem no dia.",
    instructions:
      "Converta pedidos de tempo relativo com cuidado usando a data/hora atual informada. Para 'daqui X minutos' use in_minutes. " +
      "O intent do lembrete deve ter contexto suficiente para o CTO escrever uma mensagem natural na hora (quem pediu, o porquê, detalhes).",
    tools: [
      agenda.scheduleReminder,
      agenda.listRemindersTool,
      agenda.cancelReminderTool,
      agenda.calendarListEvents,
      agenda.calendarCreateEvent,
      core.getDatetime,
    ],
  },
  {
    id: "financeiro",
    name: "Financeiro",
    emoji: "💰",
    role:
      "Finanças pessoais (o Planejai original): anotar gastos e receitas, resumos do mês, categorias, apagar lançamentos " +
      "e gerar links de pagamento (Mercado Pago/Stripe).",
    instructions:
      "Valores em reais. Escolha a categoria mais adequada. Ao anotar, devolva o valor, a categoria e o total do mês naquela categoria. " +
      "Links de pagamento só com confirmed_by_user=true quando o CTO informar que a pessoa confirmou.",
    tools: [finance.addTransaction, finance.listTransactions, finance.financeSummary, finance.deleteTransaction, finance.createPaymentLink],
  },
  {
    id: "comunicacao",
    name: "Comunicação",
    emoji: "✉️",
    role: "E-mail (Gmail) e Slack: buscar, ler, resumir, redigir e enviar mensagens.",
    instructions:
      "Para enviar qualquer coisa, primeiro devolva o rascunho ao CTO; só envie com confirmed_by_user=true quando o CTO disser que a pessoa aprovou.",
    tools: [comm.gmailSearch, comm.gmailRead, comm.gmailSend, comm.slackListChannels, comm.slackReadChannel, comm.slackSendMessage],
  },
  {
    id: "produtividade",
    name: "Produtividade",
    emoji: "🗂️",
    role: "Notion (páginas, notas, bancos), Linear e GitHub (issues, PRs).",
    instructions: "Retorne links diretos para o que encontrar ou criar.",
    tools: [
      prod.notionSearch,
      prod.notionReadPage,
      prod.notionCreatePage,
      prod.githubSearchIssues,
      prod.githubCreateIssue,
      prod.linearSearchIssues,
      prod.linearCreateIssue,
    ],
  },
];

export const CTO_TOOLS: Tool[] = [core.reactToMessage, core.saveMemory, core.searchMemories, core.forgetMemory, core.getDatetime];

export const CTO: Omit<AgentDef, "tools"> = {
  id: "cto",
  name: "CTO",
  emoji: "🧠",
  role: "Orquestrador: conversa com a pessoa, decide, delega aos especialistas e compõe a resposta final.",
  instructions: "",
};

export function getSpecialist(id: string) {
  return SPECIALISTS.find((s) => s.id === id);
}
