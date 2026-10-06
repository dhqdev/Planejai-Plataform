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
      "Comece barato: web_search e fetch_url. Prefira sites oficiais (ingresso.com, sites dos cinemas, lojas oficiais) e traga dados concretos (horários, preços, links). " +
      "Use o computador (browser_open/browser_action) quando precisar interagir com o site (filtros, busca interna, formulário, vários cliques) " +
      "ou quando o CTO pedir para gravar/mostrar a navegação: nesse caso abra com record=true e send_recording=true e termine com browser_close. " +
      "Se um print ajudar (grade de sessões, cardápio, tabela), use screenshot_url ou browser_screenshot e informe o media_id. Diga o que não conseguiu confirmar.",
    tools: [
      research.webSearch,
      research.fetchUrl,
      research.screenshotUrl,
      research.browserOpen,
      research.browserAction,
      research.browserScreenshot,
      research.browserClose,
      core.attachImage,
      core.readDocument,
    ],
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
      "Finanças pessoais: gastos e receitas (inclusive de comprovantes, notas, faturas e extratos), parcelas, resumos e comparações do mês, " +
      "contas, divisão de despesas e links de pagamento (Mercado Pago/Stripe).",
    instructions:
      "Valores em reais. Nunca faça conta de cabeça: use calculate para qualquer soma, divisão, parcela, juros ou porcentagem, e use os totais " +
      "que as ferramentas devolvem. Para extratos/faturas em documento, leia com read_document e lance cada item com message_id para não duplicar. " +
      "Ao anotar, devolva o valor, a categoria e o total do mês na categoria. Links de pagamento só com confirmed_by_user=true quando o CTO informar que a pessoa confirmou.",
    tools: [
      finance.addTransaction,
      finance.listTransactions,
      finance.financeSummary,
      finance.deleteTransaction,
      finance.calculate,
      finance.createPaymentLink,
      core.readDocument,
    ],
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

/**
 * Ferramentas do CTO. Além do núcleo da conversa, ele tem atalhos para o que é simples e frequente
 * (anotar um gasto, um lembrete, uma conta), que resolve sem acionar o time e gasta menos token.
 */
export const CTO_TOOLS: Tool[] = [
  core.reactToMessage,
  core.saveMemory,
  core.searchMemories,
  core.forgetMemory,
  core.readDocument,
  finance.addTransaction,
  finance.calculate,
  agenda.scheduleReminder,
];

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
