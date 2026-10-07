import * as agenda from "./tools/agenda.js";
import * as comm from "./tools/communication.js";
import * as core from "./tools/core.js";
import * as finance from "./tools/finance.js";
import * as images from "./tools/images.js";
import * as automations from "./tools/automations.js";
import * as n8n from "./tools/n8n.js";
import * as prod from "./tools/productivity.js";
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
  /** apelido de personagem (ex.: "Nico") e carinha no painel */
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
    persona: "Pipo",
    face: { color: 6, eyes: "glasses", mouth: "open", extra: "antenna" },
    name: "Pesquisador",
    icon: "search",
    role:
      "Pesquisa qualquer coisa atual na internet: sessões de cinema, preços e lojas (inclusive Mercado Livre), restaurantes, notícias, endereços, horários, " +
      "comparações de produtos. Abre páginas e tira print de páginas para mandar como foto.",
    instructions:
      "Seja rápido: na maioria das vezes um web_search resolve; só abra a página (fetch_url) se o resumo da busca não trouxer o dado. " +
      "Prefira sites oficiais (ingresso.com, sites dos cinemas, lojas oficiais) e traga dados concretos (horários, preços, links). " +
      "Computador (browser_open/browser_action) só quando for preciso interagir com o site (filtros, busca interna, formulário, vários cliques) " +
      "ou quando o CTO pedir para gravar/mostrar a navegação: nesse caso abra com record=true e send_recording=true e termine com browser_close. " +
      "Print (screenshot_url/browser_screenshot) só quando o CTO pedir uma imagem; por padrão responda em texto. Diga o que não conseguiu confirmar.",
    tools: [
      research.webSearch,
      research.fetchUrl,
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
    persona: "Lia",
    face: { color: 2, eyes: "happy", mouth: "smile", extra: "bow" },
    name: "Agenda",
    icon: "calendar",
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
    persona: "Nico",
    face: { color: 7, eyes: "dot", mouth: "grin", extra: "cap" },
    name: "Financeiro",
    icon: "wallet",
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
      finance.setBudget,
      finance.budgetStatusTool,
      finance.makeChart,
      core.readDocument,
    ],
  },
  {
    id: "comunicacao",
    persona: "Bia",
    face: { color: 1, eyes: "wink", mouth: "cat", extra: "headset" },
    name: "Comunicação",
    icon: "mail",
    role: "E-mail (Gmail) e Slack: buscar, ler, resumir, redigir e enviar mensagens.",
    instructions:
      "Para enviar qualquer coisa, primeiro devolva o rascunho ao CTO; só envie com confirmed_by_user=true quando o CTO disser que a pessoa aprovou.",
    tools: [comm.gmailSearch, comm.gmailRead, comm.gmailSend, comm.slackListChannels, comm.slackReadChannel, comm.slackSendMessage],
  },
  {
    id: "produtividade",
    persona: "Duda",
    face: { color: 0, eyes: "wide", mouth: "smile", extra: "leaf" },
    name: "Produtividade",
    icon: "folder",
    role:
      "Automações no n8n para qualquer pessoa (avisos agendados, acompanhar notícias, sites e APIs, gatilhos), " +
      "e para o dono também Notion, Linear, GitHub e os fluxos dele no n8n (listar, ver falhas, disparar).",
    instructions:
      "Retorne links diretos para o que encontrar ou criar. Para automação: confirme com o CTO o que a pessoa quer (o quê, quando, de onde vem a informação), " +
      "monte o fluxo mais simples possível com automation_save e devolva em uma frase o que vai acontecer e quando. Se o n8n recusar, corrija e salve de novo com o mesmo workflow_id.",
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
  finance.setBudget,
  finance.makeChart,
  images.makeImage,
  agenda.scheduleReminder,
  social.sendToContact,
  social.listContactsTool,
  social.invitePerson,
  social.watchCreate,
  social.watchList,
  social.watchCancel,
];

export const CTO: Omit<AgentDef, "tools"> = {
  id: "cto",
  name: "CTO",
  persona: "Téo",
  face: { color: 4, eyes: "happy", mouth: "smile", extra: "crown" },
  icon: "brain",
  role: "Orquestrador: conversa com a pessoa, decide, delega aos especialistas e compõe a resposta final.",
  instructions: "",
};

export function getSpecialist(id: string) {
  return SPECIALISTS.find((s) => s.id === id);
}

/** Ferramentas que a melhoria diária pode dar a um agente de cliente (só leitura/pesquisa e registros simples). */
export const CLIENT_AGENT_TOOLS: Record<string, Tool> = Object.fromEntries(
  [
    research.webSearch,
    research.fetchUrl,
    research.screenshotUrl,
    research.mercadolivreSearch,
    research.browserOpen,
    research.browserAction,
    research.browserClose,
    finance.listTransactions,
    finance.financeSummary,
    finance.calculate,
    agenda.calendarListEvents,
    core.getDatetime,
    core.attachImage,
    images.makeImage,
  ].map((t) => [t.name, t]),
);

/** Agentes que a melhoria diária criou para esta pessoa, no formato do time. */
export async function clientAgents(userId: string): Promise<AgentDef[]> {
  const rows = await many("SELECT * FROM client_agents WHERE user_id = $1 AND active ORDER BY created_at", [userId]);
  return rows.map((r) => ({
    id: `c_${r.slug}`,
    name: r.name,
    persona: r.persona ?? undefined,
    face: r.face ?? faceFor(r.slug),
    icon: "sparkle",
    task: "agent:cliente",
    clientAgentId: r.id,
    role: `${r.focus} (especialista criado para esta pessoa a partir do que ela mais pede)`,
    instructions: r.instructions,
    tools: (r.tools as string[]).map((n) => CLIENT_AGENT_TOOLS[n]).filter(Boolean) as Tool[],
  }));
}
