import * as agenda from "./tools/agenda.js";
import * as comm from "./tools/communication.js";
import * as core from "./tools/core.js";
import * as finance from "./tools/finance.js";
import * as bills from "./tools/bills.js";
import * as cards from "./tools/cards.js";
import { GOAL_TOOLS } from "./tools/goals.js";
import * as images from "./tools/images.js";
import * as pdf from "./tools/pdf.js";
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
import * as shopping from "./tools/shopping.js";
import * as social from "./tools/social.js";
import { many } from "../db/pool.js";
import type { Tool } from "./tools/types.js";

/** Carinha de desenho de cada agente (desenhada no painel). */
export interface Face {
  /** índice na paleta (0 laranja, 1 coral, 2 magenta, 3 roxo-rosa, 4 roxo, 5 índigo, 6 azul, 7 verde-água) */
  color: number;
  eyes: "dot" | "happy" | "wide" | "wink" | "glasses" | "sleepy";
  mouth: "smile" | "open" | "cat" | "grin" | "o" | "flat";
  /** skin:<slug> = roupa fixa de um especialista da loja (SKINS em faces.tsx) */
  extra: "none" | "antenna" | "cap" | "bow" | "headset" | "leaf" | "crown" | `skin:${string}`;
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
  /** apelido de personagem (ex.: "Moacir") e carinha no painel */
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
    persona: "Clotilde",
    face: { color: 6, eyes: "glasses", mouth: "open", extra: "antenna" },
    name: "Pesquisador",
    icon: "search",
    role:
      "Pesquisa qualquer coisa atual na internet: sessões de cinema, restaurantes, notícias, endereços, horários, lugares perto da pessoa, " +
      "informações e avaliações de produtos, acompanhamentos (De olho: listar, ajustar, parar). Abre páginas e tira print de páginas para mandar como foto. Menor preço para comprar é com Compras.",
    instructions:
      "Seja rápido e econômico: na maioria das vezes um web_search resolve; só abra a página (fetch_url) se o resumo da busca não trouxer o dado. " +
      "Lugar perto ('petshop mais perto', 'farmácia aqui perto'): places_nearby com o endereço da pessoa, uma chamada só; traga só o que foi pedido " +
      "(pediu o mais perto, devolva 1, com endereço, distância e telefone). map_route só se pedirem rota, e para um lugar só. " +
      "Cada busca custa: no máximo 2 web_search por tarefa, sem repetir a mesma busca com outras palavras, e responda assim que tiver o dado. " +
      "Prefira sites oficiais (ingresso.com, sites dos cinemas, lojas oficiais) e traga dados concretos (horários, preços, links). " +
      "No máximo 3 páginas por tarefa; site que bloqueou ou veio vazio não se tenta de novo: entregue os links que a busca trouxe para a pessoa abrir. Link de anúncio vale mais que texto. " +
      "Navegador (browser_open/browser_action) só aparece quando pediram para ver, printar ou gravar: aí abra com record=true e send_recording=true se for gravação e termine com browser_close. " +
      "Foto ou imagem de alguma coisa (produto, lugar, desenho): make_picture, nunca navegador nem print. Print (screenshot_url/browser_screenshot) só quando pedirem o print de uma página; por padrão responda em texto. Diga o que não conseguiu confirmar.",
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
      shopping.shopSearch,
      core.attachImage,
      core.readDocument,
      images.makeImage,
      images.getPicture,
      pdf.makePdf,
      social.watchCreate,
      social.watchList,
      social.watchUpdate,
      social.watchCancel,
    ],
  },
  {
    id: "agenda",
    persona: "Cotinha",
    face: { color: 2, eyes: "happy", mouth: "smile", extra: "bow" },
    name: "Agenda",
    icon: "calendar",
    role: "Lembretes (únicos ou recorrentes), alarmes, compromissos e Google Agenda: criar, listar, mudar o horário, cancelar, ver o que tem no dia.",
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
      agenda.setAlarm,
      agenda.alarmList,
      agenda.alarmCancel,
      core.getDatetime,
    ],
  },
  {
    id: "financeiro",
    persona: "Moacir",
    face: { color: 7, eyes: "dot", mouth: "grin", extra: "cap" },
    name: "Financeiro",
    icon: "wallet",
    role:
      "Finanças pessoais com controle total: anotar, corrigir, apagar e recategorizar gastos e receitas (inclusive de comprovantes, notas, faturas e extratos), " +
      "parcelas, cartões de crédito (compras à vista e parceladas por cartão, faturas mês a mês, limite, marcar fatura paga), contas fixas com lembrete de vencimento, limites, gráficos, resumos e comparações do mês, contas, divisão de despesas e links de pagamento do Mercado Pago da pessoa.",
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
      "'paguei o aluguel' é bill_pay (já lança nas finanças, não use add_transaction junto). " +
      "Cartão de crédito: compra no cartão é add_transaction com card (apelido, banco ou final); parcelado = valor TOTAL + installments + card, e cada parcela cai na fatura do seu mês. " +
      "Pix, débito ou dinheiro: sem card. Parcelou sem dizer onde: se ela tem um cartão só, é nele; com vários, pergunte qual. " +
      "Cartão novo: card_save com apelido, dia do fechamento e do vencimento (limite e final se ela disser); nunca peça número inteiro, CVV ou validade. " +
      "Fatura é diferente de gasto do mês: 'quanto gastei em outubro' = finance_summary (pela data de cada compra/parcela); 'quanto vem a fatura' = card_invoice (pelo vencimento). " +
      "'Paguei a fatura/o cartão' é card_invoice_pay, nunca add_transaction nem bill_pay (as compras já estão lançadas; lançar de novo conta em dobro). " +
      "Compra parcelada: list_transactions mostra parcela 2/10; para trocar de cartão ou apagar a compra inteira use all_installments=true; para mudar o valor total, apague a compra inteira e lance de novo. " +
      "O sistema avisa sozinho no WhatsApp quando a fatura fecha, antes e no dia do vencimento. " +
      "Metas (juntar dinheiro para algo): goal_create com valor e prazo; 'guardei 200 na viagem' é goal_add (não é gasto, nada de add_transaction); " +
      "ao falar de gastos de quem tem meta, diga em uma frase como isso afeta a meta e quanto falta por mês (per_month), sem sermão.",
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
      cards.cardSave,
      cards.cardList,
      cards.cardInvoice,
      cards.cardInvoicePay,
      cards.cardDelete,
      ...GOAL_TOOLS,
      core.readDocument,
    ],
  },
  {
    id: "comunicacao",
    persona: "Telma",
    face: { color: 1, eyes: "wink", mouth: "cat", extra: "headset" },
    name: "Comunicação",
    icon: "mail",
    role:
      "Mensagens em nome da pessoa: WhatsApp para contatos e para qualquer número (agora ou agendada, com foto ou arquivo), mensagens agendadas, convites, " +
      "contatos e liberar telas para um contato; e-mail (Gmail) e Slack: buscar, ler, resumir, redigir e enviar.",
    instructions:
      "Para enviar, chame a ferramenta com o texto final: o sistema guarda e só envia depois do sim da pessoa. Devolva ao CTO o resumo do que vai sair para ele perguntar. " +
      "Pelo nome ('manda pra Ana'): contacts_search antes de pedir o número; se vier approximate, devolva ao CTO para confirmar quem é. " +
      "Contato do Planejai: send_to_contact; qualquer outro número: send_whatsapp (não convida nem cria contato). Com hora: agende com at na própria ferramenta, nunca troque por lembrete. " +
      "Arquivo junto: attach=true (o que ela mandou ou o assistente fez agora) ou document_id. Convite (invite_person) só com nome e número confirmados.",
    tools: [
      direct.contactsSearch,
      social.sendToContact,
      direct.sendWhatsapp,
      direct.contactSave,
      direct.directList,
      direct.directCancel,
      social.invitePerson,
      social.listContactsTool,
      social.shareScreen,
      comm.gmailSearch,
      comm.gmailRead,
      comm.gmailSend,
      comm.slackListChannels,
      comm.slackReadChannel,
      comm.slackSendMessage,
    ],
  },
  {
    id: "produtividade",
    persona: "Nivaldo",
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
    persona: "Zezinho",
    face: { color: 3, eyes: "dot", mouth: "open", extra: "none" },
    name: "Recados",
    icon: "send",
    role:
      "Fala com estabelecimentos pelo WhatsApp em nome da pessoa (petshop, salão, clínica, restaurante): acha o lugar e o telefone, pergunta horário, preço ou disponibilidade " +
      "e agenda dentro do que ela liberou ('se tiver 18h, marca'). As respostas deles são acompanhadas sozinhas, mesmo depois desta conversa.",
    instructions:
      "Ache o lugar com places_nearby (endereço da pessoa) e o telefone; sem telefone, uma web_search pelo nome + 'whatsapp'. " +
      "Monte o errand_start: message como gente, sem cumprimento (o sistema põe 'Oi, boa tarde! Tudo bem? Aqui é o assistente virtual de X.'): " +
      "contexto mínimo e depois a pergunta com jeito, uma só (ex.: 'Ela tem um shih-tzu e queria saber sobre tosa com vocês. Vocês conseguem me passar o valor?'), nunca só a pergunta seca; " +
      "goal com serviço, detalhes que ela deu e data absoluta, " +
      "allowed só com o que a pessoa liberou de forma concreta (ex.: 'se tiver banho às 18h de hoje, confirmar'). " +
      "errand_start não envia nada: o sistema guarda e pergunta à pessoa. Devolva ao CTO, em uma frase, para quem vai, o texto e o que fica liberado, para ele perguntar o sim. " +
      "Sem número com WhatsApp, devolva o telefone para a pessoa ligar.",
    tools: [places.placesNearby, direct.contactsSearch, research.webSearch, research.fetchUrl, errands.errandStart, errands.errandList, errands.errandCancel, core.getDatetime],
  },
];

SPECIALISTS.push({
  id: "compras",
  persona: "Nina",
  face: { color: 5, eyes: "happy", mouth: "smile", extra: "none" },
  name: "Compras",
  icon: "shop",
  role:
    "Acha o menor preço de um produto nas lojas (Mercado Livre e Shopee ao mesmo tempo), compara e manda o link para a pessoa comprar no app da loja. " +
    "Guarda o que ela quer na lista de compras e fica de olho no preço para avisar quando baixar.",
  instructions:
    "1) shop_search com marca e modelo e, em variant, o tamanho, cor, voltagem ou memória que a pessoa disse. Se voltar ask_first, devolva ao CTO só essa pergunta (sem ofertas); " +
    "com a resposta, busque de novo com variant ('tanto faz' se ela disse que qualquer serve). " +
    "2) Devolva ao CTO as 3 melhores, uma por linha: loja, nome curto, preço como veio, frete grátis se tiver, e o link. " +
    "Oferta com variant_ok: diga que o link já abre na variação dela. Com pick: junte a frase do pick na linha (ela escolhe isso na página antes de pagar). " +
    "Diga qual vale mais a pena em uma frase (mais barata, ou a de loja oficial se a diferença for pequena). " +
    "3) Sem ofertas das lojas (veio web): passe os links da web dizendo que o preço é para conferir na página. " +
    "4) 'Me avisa quando baixar' ou 'guarda pra mim': shop_save com o preço em centavos, o link da oferta escolhida e a mesma variant (alert=true; alert_below se ela disse um valor). " +
    "'Comprei' ou 'tira da lista': shop_list e shop_update. Se shop_update devolver finance_offer, devolva ao CTO essa pergunta; quem lança o gasto é o Financeiro, depois do sim dela. " +
    "Você não compra nem paga nada: a compra é sempre da pessoa, no app da loja, logada. Nunca diga que comprou, reservou ou pagou. " +
    "Não ofereça arma, remédio de receita, bebida alcoólica, cigarro ou cópia pirata.",
  tools: [shopping.shopSearch, shopping.shopSave, shopping.shopList, shopping.shopUpdate, research.webSearch, research.fetchUrl],
});

/**
 * Ferramentas do CTO que vão em toda chamada: o núcleo da conversa e os atalhos para o que é simples e frequente
 * (anotar um gasto, um lembrete, uma conta), que ele resolve sem acionar o time e gasta menos token.
 * O resto entra só quando a mensagem pede (CTO_TOOL_GROUPS), porque cada definição é paga em toda chamada.
 */
export const CTO_TOOLS: Tool[] = [
  core.reactToMessage,
  core.saveMemory,
  core.searchMemories,
  core.forgetMemory,
  core.readDocument,
  finance.addTransaction,
  finance.calculate,
  finance.makeChart,
  bills.billPay,
  places.placesNearby,
  research.mapRoute,
  research.webSearch,
  documents.documentSave,
  documents.documentList,
  documents.documentSend,
  agenda.scheduleReminder,
  agenda.setAlarm,
  agenda.calendarCreateEvent,
  social.watchCreate,
  errands.errandContinue,
  support.contactOwner,
];

/**
 * Ferramentas do CTO que só entram quando a mensagem (ou a última fala dele) toca no assunto. Sem o grupo,
 * o CTO ainda chega lá pelo especialista que também tem essas ferramentas (ver a linha "Sem a ferramenta" no prompt).
 */
export const CTO_TOOL_GROUPS: { id: string; when: RegExp; tools: Tool[] }[] = [
  {
    id: "mensagens",
    when: /(?<!\p{L})(mand|envi|mensage|msg|recado|avis[ae] (o|a|pr)|fala (pr|com)|diz(er|e)? (pr|que)|convi|contato|n[uú]mero|whats|zap|agendad)|te mandou|\d{8,}|\(\d{2}\)/iu,
    tools: [social.sendToContact, direct.sendWhatsapp, direct.contactsSearch, direct.contactSave, direct.directList, direct.directCancel, social.invitePerson],
  },
  {
    id: "midia",
    when: /(?<!\p{L})(imag|foto|figura|desenh|ilustr|mapa mental|tabela|card|pdf|relat[oó]rio|apostila|e-?book|livro|documento|resum|[aá]udio|voz|ouvir|l[eê] (pra|para) mim|gif|passo a passo|cart[aã]z|logo)/iu,
    tools: [images.makeImage, images.getPicture, images.sendGif, pdf.makePdf, audio.makeAudio],
  },
  {
    id: "contatos",
    when: /(?<!\p{L})(contatos?|liber|compartilh|acesso|tira (o|a) )/iu,
    tools: [social.listContactsTool, social.shareScreen],
  },
  { id: "acompanhamentos", when: /(?<!\p{L})(de olho|acompanh|monitor|avis\w* quando)/iu, tools: [social.watchList, social.watchCancel, social.watchUpdate] },
  { id: "alarmes", when: /(?<!\p{L})(alarme|despert|acord)/iu, tools: [agenda.alarmList, agenda.alarmCancel] },
  { id: "dinheiro", when: /(?<!\p{L})(limite|or[çc]amento|teto|no m[aá]ximo|fatura|cart[aã]o)/iu, tools: [finance.setBudget, cards.cardInvoicePay] },
  { id: "recados", when: /(?<!\p{L})(recado|estabelecimento)/iu, tools: [errands.errandList, errands.errandCancel] },
  { id: "documentos", when: /(?<!\p{L})(apag|exclu|delet|remov)\w*.{0,40}\b(document|arquivo|pdf|contrato)/iu, tools: [documents.documentDelete] },
];

/** Assunto do time sob medida (team_create_agent e companhia, em tools/team.ts). */
export const TEAM_TOOLS_WHEN = /\b(agente|especialista|time|equipe)\b/i;

/** Grupos de CTO_TOOL_GROUPS que este texto pede. */
export function ctoGroups(text: string) {
  return CTO_TOOL_GROUPS.filter((g) => g.when.test(text));
}

export const CTO: Omit<AgentDef, "tools"> = {
  id: "cto",
  name: "CTO",
  persona: "Juvenal",
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
    cards.cardList,
    cards.cardInvoice,
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
    images.getPicture,
    pdf.makePdf,
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
