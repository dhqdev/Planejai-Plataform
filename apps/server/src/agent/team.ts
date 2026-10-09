import * as agenda from "./tools/agenda.js";
import * as comm from "./tools/communication.js";
import * as core from "./tools/core.js";
import * as finance from "./tools/finance.js";
import * as bills from "./tools/bills.js";
import * as images from "./tools/images.js";
import * as audio from "./tools/audio.js";
import * as automations from "./tools/automations.js";
import * as documents from "./tools/documents.js";
import * as n8n from "./tools/n8n.js";
import * as prod from "./tools/productivity.js";
import * as errands from "./tools/errands.js";
import * as direct from "./tools/direct.js";
import * as support from "./tools/support.js";
import * as places from "./tools/places.js";
import * as research from "./tools/research.js";
import * as social from "./tools/social.js";
import { many } from "../db/pool.js";
import type { Tool } from "./tools/types.js";

/** Carinha de desenho de cada agente (desenhada no painel). */
export interface Face {
  /** índice na paleta (0 laranja, 1 coral, 2 magenta, 3 roxo-rosa, 4 roxo, 5 índigo, 6 azul, 7 verde-água) */
  color: number;
  eyes: "dot" | "happy" | "wide" | "wink" | "glasses" | "sleepy";
  mouth: "smile" | "open" | "cat" | "grin" | "o" | "flat";
  extra: "none" | "antenna" | "cap" | "bow" | "headset" | "leaf" | "crown";
}

const EYES: Face["eyes"][] = ["dot", "happy", "wide", "wink", "glasses", "sleepy"];
const MOUTHS: Face["mouth"][] = ["smile", "open", "cat", "grin", "o", "flat"];
const EXTRAS: Face["extra"][] = ["none", "antenna", "cap", "bow", "headset", "leaf", "crown"];

/** Carinha estável a partir de um texto (o mesmo agente sempre tem a mesma cara). */
export function faceFor(seed: string): Face {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return { color: h % 8, eyes: EYES[(h >>> 3) % EYES.length]!, mouth: MOUTHS[(h >>> 7) % MOUTHS.length]!, extra: EXTRAS[(h >>> 11) % EXTRAS.length]! };
}

export interface AgentDef {
  id: string;
  name: string;
  /** apelido de personagem (ex.: "Tostão") e carinha no painel */
  persona?: string;
  face?: Face;
  /** ícone no painel (nome do conjunto de ícones do dashboard) */
  icon: string;
  /** rota de modelo; padrão agent:<id> */
  task?: string;
  /** agente criado para um cliente pela melhoria diária */
  clientAgentId?: string;
  /** descrição usada pelo CTO para decidir quando delegar */
  role: string;
  instructions: string;
  tools: Tool[];
}

/** Especialistas do time. Cada um tem ferramentas próprias e uma rota de modelo ("agent:<id>"). */
export const SPECIALISTS: AgentDef[] = [
  {
    id: "pesquisador",
    persona: "Lupa",
    face: { color: 6, eyes: "glasses", mouth: "open", extra: "antenna" },
    name: "Pesquisador",
    icon: "search",
    role:
      "Pesquisa qualquer coisa atual na internet: sessões de cinema, preços e lojas (inclusive Mercado Livre), restaurantes, notícias, endereços, horários, " +
      "lugares perto da pessoa, comparações de produtos. Abre páginas e tira print de páginas para mandar como foto.",
    instructions:
      "Seja rápido e econômico: na maioria das vezes um web_search resolve; só abra a página (fetch_url) se o resumo da busca não trouxer o dado. " +
      "Lugar perto ('petshop mais perto', 'farmácia aqui perto'): places_nearby com o endereço da pessoa, uma chamada só; traga só o que foi pedido " +
      "(pediu o mais perto, devolva 1, com endereço, distância e telefone). map_route só se pedirem rota, e para um lugar só. " +
      "Cada busca custa: no máximo 2 web_search por tarefa, sem repetir a mesma busca com outras palavras, e responda assim que tiver o dado. " +
      "Prefira sites oficiais (ingresso.com, sites dos cinemas, lojas oficiais) e traga dados concretos (horários, preços, links). " +
      "Computador (browser_open/browser_action) é lento e pesa na máquina: último recurso, só quando busca e páginas não resolvem e o site exige interação (filtros, busca interna, formulário, vários cliques), nunca para mapa, " +
      "ou quando o CTO pedir para gravar/mostrar a navegação: nesse caso abra com record=true e send_recording=true e termine com browser_close. " +
      "Print (screenshot_url/browser_screenshot) só quando o CTO pedir uma imagem; por padrão responda em texto. Diga o que não conseguiu confirmar.",
    tools: [
      research.webSearch,
      research.fetchUrl,
      places.placesNearby,
      research.mapRoute,
      research.screenshotUrl,
      research.browserOpen,
      research.browserAction,
      research.browserScreenshot,
      research.browserClose,
      research.mercadolivreSearch,
      core.attachImage,
      core.readDocument,
      images.makeImage,
    ],
  },
  {
    id: "agenda",
    persona: "Sininho",
    face: { color: 2, eyes: "happy", mouth: "smile", extra: "bow" },
    name: "Agenda",
    icon: "calendar",
    role: "Lembretes (únicos ou recorrentes), compromissos e Google Agenda: criar, listar, mudar o horário, cancelar, ver o que tem no dia.",
    instructions:
      "Converta pedidos de tempo relativo com cuidado usando a data/hora atual informada. Para 'daqui X minutos' use in_minutes. " +
      "O intent do lembrete deve ter contexto suficiente para o CTO escrever uma mensagem natural na hora (quem pediu, o porquê, detalhes). " +
      "Reunião 'via meet' ou online: calendar_create_event com meet=true; e-mail de alguém no pedido vira attendees (o Google convida e lembra a pessoa).",
    tools: [
      agenda.scheduleReminder,
      agenda.listRemindersTool,
      agenda.rescheduleReminderTool,
      agenda.cancelReminderTool,
      agenda.calendarListEvents,
      agenda.calendarCreateEvent,
      core.getDatetime,
    ],
  },
  {
    id: "financeiro",
    persona: "Tostão",
    face: { color: 7, eyes: "dot", mouth: "grin", extra: "cap" },
    name: "Financeiro",
    icon: "wallet",
    role:
      "Finanças pessoais com controle total: anotar, corrigir, apagar e recategorizar gastos e receitas (inclusive de comprovantes, notas, faturas e extratos), " +
      "parcelas, contas fixas com lembrete de vencimento, limites, gráficos, resumos e comparações do mês, contas, divisão de despesas e links de pagamento do Mercado Pago da pessoa.",
    instructions:
      "Valores em reais. Nunca faça conta de cabeça: use calculate para qualquer soma, divisão, parcela, juros ou porcentagem, e use os totais " +
      "que as ferramentas devolvem. Para extratos/faturas em documento, leia com read_document e lance cada item com message_id para não duplicar. " +
      "Ao anotar, devolva o valor, a categoria e o total do mês na categoria. Você cuida de tudo nas finanças da pessoa: anotar, corrigir (update_transaction), " +
      "apagar (delete_transaction), recategorizar, limites, gráficos e conversar sobre os gastos. Para corrigir ou apagar, ache os ids com list_transactions. " +
      "Apagar vários por filtro pede o sim da pessoa (o sistema confirma sozinho). Finanças de um contato só com of_contact e só para ler (se ele compartilhou). " +
      "Link de pagamento: chame a ferramenta; o sistema guarda e só gera depois do sim da pessoa. " +
      "Foto ou lista com vários gastos (linhas ITEM:): lance todos, um add_transaction por item com o mesmo message_id e item=1, 2, 3…, e devolva quantos lançou e o total. " +
      "Pedido com mais de uma parte (ex.: apagar os antigos e lançar os da foto): faça todas; não ter nada para apagar não encerra a tarefa. " +
      "Seu relatório começa direto pelo resultado, sem prefixo [CTO]. " +
      "Data sem ano (??-MM-DD, 'dia 6', 'terça 06 de outubro') é do ano atual; se assim cair no futuro, é do ano passado. Nunca chute outro ano. " +
      "Só diga que lançou, corrigiu ou apagou o que a ferramenta confirmou (ok e ids); se der erro, conte o erro. " +
      "Contas fixas (aluguel, internet, parcela, salário todo mês): bill_save cria com o dia do vencimento e o sistema lembra sozinho; " +
      "'paguei o aluguel' é bill_pay (já lança nas finanças, não use add_transaction junto).",
    tools: [
      finance.addTransaction,
      finance.listTransactions,
      finance.financeSummary,
      finance.updateTransaction,
      finance.deleteTransaction,
      finance.calculate,
      finance.createPaymentLink,
      finance.setBudget,
      finance.budgetStatusTool,
      finance.makeChart,
      bills.billSave,
      bills.billList,
      bills.billPay,
      bills.billDelete,
      core.readDocument,
    ],
  },
  {
    id: "comunicacao",
    persona: "Carta",
    face: { color: 1, eyes: "wink", mouth: "cat", extra: "headset" },
    name: "Comunicação",
    icon: "mail",
    role: "E-mail (Gmail) e Slack: buscar, ler, resumir, redigir e enviar mensagens.",
    instructions:
      "Para enviar, chame a ferramenta com o texto final: o sistema guarda e só envia depois do sim da pessoa. Devolva ao CTO o resumo do que vai sair para ele perguntar.",
    tools: [comm.gmailSearch, comm.gmailRead, comm.gmailSend, comm.slackListChannels, comm.slackReadChannel, comm.slackSendMessage],
  },
  {
    id: "produtividade",
    persona: "Bloco",
    face: { color: 0, eyes: "wide", mouth: "smile", extra: "leaf" },
    name: "Produtividade",
    icon: "folder",
    role:
      "Automações no n8n para qualquer pessoa (avisos agendados, acompanhar notícias, sites e APIs, gatilhos), " +
      "Notion, Linear e GitHub da conta que a pessoa conectou, e para o dono os fluxos dele no n8n (listar, ver falhas, disparar).",
    instructions:
      "Retorne links diretos para o que encontrar ou criar. Para automação: confirme com o CTO o que a pessoa quer (o quê, quando, de onde vem a informação), " +
      "peça o guia do formato com automation_save nodes=[] (uma vez por tarefa), monte o fluxo mais simples possível e devolva em uma frase o que vai acontecer e quando. " +
      "Se o n8n recusar, corrija e salve de novo com o mesmo workflow_id.",
    tools: [
      prod.notionSearch,
      prod.notionReadPage,
      prod.notionCreatePage,
      prod.githubSearchIssues,
      prod.githubCreateIssue,
      prod.linearSearchIssues,
      prod.linearCreateIssue,
      n8n.n8nWorkflows,
      n8n.n8nExecutions,
      n8n.n8nTrigger,
      automations.automationSave,
      automations.automationList,
      automations.automationManage,
      automations.automationStatus,
    ],
  },
  {
    id: "recados",
    persona: "Pombo",
    face: { color: 3, eyes: "dot", mouth: "open", extra: "none" },
    name: "Recados",
    icon: "send",
    role:
      "Fala com estabelecimentos pelo WhatsApp em nome da pessoa (petshop, salão, clínica, restaurante): acha o lugar e o telefone, pergunta horário, preço ou disponibilidade " +
      "e agenda dentro do que ela liberou ('se tiver 18h, marca'). As respostas deles são acompanhadas sozinhas, mesmo depois desta conversa.",
    instructions:
      "Ache o lugar com places_nearby (endereço da pessoa) e o telefone; sem telefone, uma web_search pelo nome + 'whatsapp'. " +
      "Monte o errand_start: message curta e educada (o sistema já apresenta como assistente da pessoa), goal com serviço e data absoluta, " +
      "allowed só com o que a pessoa liberou de forma concreta (ex.: 'se tiver banho às 18h de hoje, confirmar'). " +
      "errand_start não envia nada: o sistema guarda e pergunta à pessoa. Devolva ao CTO, em uma frase, para quem vai, o texto e o que fica liberado, para ele perguntar o sim. " +
      "Sem número com WhatsApp, devolva o telefone para a pessoa ligar.",
    tools: [places.placesNearby, research.webSearch, research.fetchUrl, errands.errandStart, errands.errandList, errands.errandCancel, core.getDatetime],
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
  finance.setBudget,
  finance.makeChart,
  bills.billPay,
  images.makeImage,
  audio.makeAudio,
  places.placesNearby,
  research.mapRoute,
  documents.documentSave,
  documents.documentList,
  documents.documentSend,
  documents.documentDelete,
  agenda.scheduleReminder,
  agenda.setAlarm,
  agenda.alarmList,
  agenda.alarmCancel,
  agenda.calendarCreateEvent,
  social.sendToContact,
  direct.sendWhatsapp,
  direct.directList,
  direct.directCancel,
  social.listContactsTool,
  social.invitePerson,
  social.shareScreen,
  social.watchCreate,
  social.watchList,
  social.watchCancel,
  social.watchUpdate,
  errands.errandContinue,
  errands.errandList,
  errands.errandCancel,
  support.contactOwner,
];

export const CTO: Omit<AgentDef, "tools"> = {
  id: "cto",
  name: "CTO",
  persona: "Maestro",
  face: { color: 4, eyes: "happy", mouth: "smile", extra: "crown" },
  icon: "brain",
  role: "Orquestrador: conversa com a pessoa, decide, delega aos especialistas e compõe a resposta final.",
  instructions: "",
};

/** Quantos agentes sob medida uma pessoa pode ter ao mesmo tempo (criados pela reunião noturna ou a pedido dela). */
export const MAX_CLIENT_AGENTS = 6;

export const slugify = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 24);

/**
 * Ferramentas que um agente sob medida pode ter: leitura, pesquisa, registros simples e o que já é seguro
 * por construção para qualquer pessoa (lembretes e automações dela mesma). Nada que mande mensagem a terceiros ou mova dinheiro.
 */
export const CLIENT_AGENT_TOOLS: Record<string, Tool> = Object.fromEntries(
  [
    research.webSearch,
    research.fetchUrl,
    research.screenshotUrl,
    research.mercadolivreSearch,
    places.placesNearby,
    research.mapRoute,
    research.browserOpen,
    research.browserAction,
    research.browserClose,
    finance.listTransactions,
    finance.financeSummary,
    finance.budgetStatusTool,
    finance.calculate,
    finance.makeChart,
    bills.billList,
    agenda.calendarListEvents,
    agenda.scheduleReminder,
    agenda.listRemindersTool,
    automations.automationSave,
    automations.automationList,
    automations.automationStatus,
    core.getDatetime,
    core.attachImage,
    core.readDocument,
    images.makeImage,
  ].map((t) => [t.name, t]),
);

/** Linha de client_agents no formato do time. */
export function clientAgentDef(r: any): AgentDef {
  return {
    id: `c_${r.slug}`,
    name: r.name,
    persona: r.persona ?? undefined,
    face: r.face ?? faceFor(r.slug),
    icon: "sparkle",
    task: "agent:cliente",
    clientAgentId: r.id,
    role: `${r.focus} (especialista criado só para esta pessoa)`,
    instructions: r.instructions,
    tools: (r.tools as string[]).map((n) => CLIENT_AGENT_TOOLS[n]).filter(Boolean) as Tool[],
  };
}

/** Agentes sob medida desta pessoa (criados pela reunião noturna ou por ela, na conversa). */
export async function clientAgents(userId: string): Promise<AgentDef[]> {
  const rows = await many("SELECT * FROM client_agents WHERE user_id = $1 AND active ORDER BY created_at", [userId]);
  return rows.map(clientAgentDef);
}
