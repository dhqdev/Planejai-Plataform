import { phoneFmt } from "../../api";
import { AGENT_ICON, AGENT_LABEL } from "../../components";
import { CORE_FACES, type Face } from "../../faces";
import { firstWords } from "./format";

/* Rótulos das Execuções: como o painel chama, em português, gatilhos, canais, ferramentas e agentes. */

export const TRIGGER_LABEL: Record<string, string> = { message: "Mensagem", reminder: "Lembrete", playground: "Teste", watch: "De olho", improve: "Reunião noturna", summary: "Resumo", errand: "Recado" };
export const TRIGGER_ICON: Record<string, string> = { message: "send", reminder: "bell", playground: "play", watch: "eye", improve: "sparkle", summary: "book", errand: "send" };
/** Quando não há texto de entrada, o que disparou a execução. */
export const TRIGGER_FALLBACK: Record<string, string> = { message: "Mensagem recebida", reminder: "Lembrete disparado", playground: "Teste no painel", watch: "Conferência do De olho", improve: "Reunião noturna do time", summary: "Resumo da conversa antiga", errand: "Resposta de um estabelecimento" };
const CHANNEL_LABEL: Record<string, string> = { baileys: "WhatsApp", evolution: "WhatsApp", cloud: "WhatsApp", telegram: "Telegram", playground: "Painel" };

/** Ferramentas em português, como a pessoa entenderia o que o time fez. */
const TOOL_LABEL: Record<string, string> = {
  add_transaction: "Registrou um lançamento",
  delete_transaction: "Apagou lançamentos",
  update_transaction: "Corrigiu lançamentos",
  list_transactions: "Consultou lançamentos",
  finance_summary: "Montou o resumo financeiro",
  budget_status: "Conferiu os limites do mês",
  set_budget: "Definiu um limite",
  calculate: "Fez uma conta",
  create_payment_link: "Criou um link de pagamento",
  schedule_reminder: "Agendou um lembrete",
  list_reminders: "Consultou lembretes",
  cancel_reminder: "Cancelou um lembrete",
  reschedule_reminder: "Mudou o horário de um lembrete",
  calendar_create_event: "Criou evento na agenda",
  calendar_list_events: "Consultou a agenda",
  save_memory: "Guardou na memória",
  search_memories: "Buscou na memória",
  forget_memory: "Esqueceu uma memória",
  react_to_message: "Reagiu à mensagem",
  get_datetime: "Conferiu data e hora",
  web_search: "Pesquisou na internet",
  fetch_url: "Abriu uma página",
  screenshot_url: "Tirou print de uma página",
  browser_open: "Abriu o navegador",
  browser_action: "Agiu no navegador",
  browser_screenshot: "Print do navegador",
  browser_close: "Fechou o navegador",
  read_document: "Leu um documento",
  make_chart: "Gerou um gráfico",
  make_image: "Gerou uma imagem",
  attach_image: "Anexou uma imagem",
  mercadolivre_search: "Buscou no Mercado Livre",
  places_nearby: "Achou lugares perto",
  errand_start: "Mandou mensagem a um estabelecimento",
  errand_reply: "Respondeu ao estabelecimento",
  errand_done: "Fechou o recado",
  errand_ask_person: "Levou uma decisão para a pessoa",
  errand_continue: "Mandou a decisão ao estabelecimento",
  errand_list: "Consultou os recados",
  errand_cancel: "Cancelou um recado",
  contact_owner: "Avisou o responsável",
  map_route: "Montou a rota no mapa",
  watch_create: "Criou um acompanhamento",
  watch_list: "Consultou os acompanhamentos",
  watch_cancel: "Parou um acompanhamento",
  watch_update: "Ajustou um acompanhamento",
  send_to_contact: "Enviou para um contato",
  list_contacts: "Consultou contatos",
  invite_person: "Convidou uma pessoa",
  share_screen: "Mudou o que um contato pode ver",
  gmail_search: "Buscou no Gmail",
  gmail_read: "Leu um e-mail",
  gmail_send: "Enviou um e-mail",
  notion_search: "Buscou no Notion",
  notion_read_page: "Leu página do Notion",
  notion_create_page: "Criou página no Notion",
  github_search_issues: "Buscou issues no GitHub",
  github_create_issue: "Abriu issue no GitHub",
  linear_search_issues: "Buscou no Linear",
  linear_create_issue: "Criou tarefa no Linear",
  slack_list_channels: "Listou canais do Slack",
  slack_read_channel: "Leu canal do Slack",
  slack_send_message: "Mandou mensagem no Slack",
  automation_save: "Salvou uma automação",
  automation_list: "Consultou automações",
  automation_manage: "Mexeu numa automação",
  n8n_workflows: "Consultou fluxos do n8n",
  n8n_executions: "Consultou execuções do n8n",
  n8n_trigger: "Disparou um fluxo do n8n",
  share_with_team: "Anotou no quadro do time",
  transcrever_audio: "Transcreveu o áudio",
  descrever_imagem: "Olhou a foto",
  ler_documento: "Leu o documento",
  assistir_video: "Assistiu ao vídeo",
  enviar_texto: "Enviou a resposta",
  enviar_imagem: "Enviou uma imagem",
  aviso_andamento: "Avisou que está trabalhando",
};
const TOOL_ICON: [RegExp, string][] = [
  [/transaction|finance|budget|payment/, "wallet"],
  [/calculate/, "hash"],
  [/reminder/, "bell"],
  [/calendar|datetime/, "calendar"],
  [/memor/, "bookmark"],
  [/react/, "heart"],
  [/places|map_route/, "target"],
  [/errand/, "send"],
  [/web_search|search/, "search"],
  [/fetch_url|browser|screenshot/, "globe"],
  [/document|ler_doc/, "book"],
  [/chart/, "trend"],
  [/image|imagem|foto/, "layout"],
  [/mercadolivre/, "shop"],
  [/watch/, "eye"],
  [/contact|invite/, "users"],
  [/gmail|mail/, "mail"],
  [/notion/, "bookmark"],
  [/github/, "github"],
  [/linear/, "target"],
  [/slack/, "hash"],
  [/automation|n8n/, "graph"],
  [/share_with_team/, "edit"],
  [/audio/, "activity"],
  [/video/, "play"],
];
export const toolLabel = (name: string) => TOOL_LABEL[name] ?? name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
/** O que o modelo decidiu fazer, em português ("chamar Tostão", "pesquisou na internet"). */
export function callLabel(name: string, clientAgents: any[], cap = false) {
  const m = /^(ask|consult)_(.+)$/.exec(name);
  const t = m ? `chamar ${who(agentMeta(m[2]!, clientAgents))}` : toolLabel(name).toLowerCase();
  return cap ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}
export const toolIcon = (name: string) => TOOL_ICON.find(([re]) => re.test(name))?.[1] ?? "settings";
/** Ícone de cada tipo de passo (ferramenta tem o seu, pelo toolIcon). */
export const TYPE_ICON: Record<string, string> = { llm: "sparkle", tool: "settings", delegate: "arrow", channel: "send", info: "shield" };

/** Resumo de uma linha dos argumentos de uma ferramenta (o texto que mais diz o que foi feito). */
export function argSummary(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return firstWords(input, 18);
  if (typeof input !== "object") return String(input);
  const o = input as Record<string, unknown>;
  for (const k of ["query", "q", "text", "message", "question", "description", "title", "note", "content", "url", "expression", "name", "when", "category"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return firstWords(v, 18);
  }
  const parts = Object.entries(o)
    .filter(([k, v]) => !["confirm", "emoji", "reacao"].includes(k) && v != null && typeof v !== "object")
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${String(v)}`);
  return firstWords(parts.join(" · "), 18);
}

export interface AgentMeta { id: string; name: string; persona?: string; face?: Face | null; icon: string }
export function agentMeta(id: string, clientAgents: any[] = []): AgentMeta {
  const core = CORE_FACES[id];
  if (core) return { id, name: AGENT_LABEL[id] ?? id, persona: core.persona, face: core.face, icon: AGENT_ICON[id] ?? "sparkle" };
  const c = clientAgents.find((a) => a.id === id);
  if (c) return { id, name: c.name, persona: c.persona ?? undefined, face: c.face ?? null, icon: "sparkle" };
  if (id === "acompanhamento") return { id, name: "De olho", icon: "eye" };
  return { id, name: id.replace(/^c_/, ""), icon: id.startsWith("c_") ? "sparkle" : "circle" };
}
export const who = (m: AgentMeta) => m.persona ?? m.name;

/** "openrouter/gpt-x" vira "gpt-x": o fornecedor não interessa na tela. */
export const shortModel = (model: string | null | undefined) => String(model ?? "").replace(/^[^/]+\//, "");
/** Um passo de delegação se chama ask_<agente> ou consult_<agente>. */
export const isDelegation = (name: string) => name.startsWith("ask_") || name.startsWith("consult_");
export const delegateTarget = (name: string) => name.replace(/^(ask|consult)_/, "");

/** Título de uma execução: o começo do que a pessoa mandou ou, sem texto (ou apagado), o que a disparou. */
export function executionTitle(e: any, words: number) {
  return e.content_purged ? TRIGGER_FALLBACK[e.trigger] ?? "Execução" : firstWords(e.input, words) || TRIGGER_FALLBACK[e.trigger] || "Execução";
}
export const channelOf = (e: any): string | null => (e.channel ? CHANNEL_LABEL[e.channel] ?? e.channel : null);
/** Quem mandou: nome ou telefone; null quando foi o próprio sistema. */
export const personOf = (e: any): string | null => e.user_name ?? (e.phone ? phoneFmt(e.phone) : null);
