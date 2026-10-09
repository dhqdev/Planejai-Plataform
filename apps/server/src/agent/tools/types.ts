import type { Channel, OutboundImage } from "../../channels/types.js";
import type { TeamRoom } from "../collab.js";
import type { Guard } from "../guard.js";
import type { Tracer } from "../trace.js";
import { query } from "../../db/pool.js";

export interface UserRow {
  id: string;
  phone: string;
  name: string | null;
  status: string;
  timezone: string | null;
  profile: Record<string, unknown>;
}

export interface ConversationRow {
  id: string;
  user_id: string;
  channel: string;
  remote_jid: string;
  summary: string | null;
  summary_until: number;
}

/** Mídias geradas durante a execução (prints, imagens) que o CTO posiciona com [[media:ID]] */
export class Outbox {
  media = new Map<string, OutboundImage>();
  reactions: { messageId: string; emoji: string }[] = [];
  private seq = 0;
  addMedia(img: OutboundImage) {
    const id = `m${++this.seq}`;
    this.media.set(id, img);
    return id;
  }
}

export interface ToolContext {
  user: UserRow;
  conversation: ConversationRow;
  channel: Channel;
  tracer: Tracer;
  outbox: Outbox;
  timezone: string;
  /** id (no provedor) da última mensagem recebida da pessoa */
  lastInboundId?: string;
  parentStepId?: number;
  agent: string;
  /** sala do time nesta execução: conversas com cada especialista e quadro compartilhado */
  room: TeamRoom;
  /** quem chamou quem até aqui (evita ciclos A -> B -> A) */
  callChain: string[];
  /** travas da execução (prazo e número de ações), as mesmas para o time todo */
  guard?: Guard;
  /** fotos que chegaram nesta rodada (só em memória), para encaminhar a um contato */
  inboundImages?: { base64: string; mimetype: string }[];
  /** mensagens novas desta rodada já interpretadas (foto descrita, documento lido), com msg_id; o especialista recebe junto quando há mídia */
  inboundText?: string;
  /** só o que a pessoa digitou nesta rodada (sem descrição de foto nem texto de documento): vale como confirmação dela */
  typedText?: string;
  /** arquivos (documentos e fotos) que chegaram nesta rodada, só em memória, para guardar em Documentos */
  inboundFiles?: { base64: string; mimetype: string; fileName?: string }[];
  /** avisos de andamento e "digitando..." para a pessoa enquanto o time trabalha */
  progress?: import("../progress.js").Progress;
  /** ferramenta que está rodando agora (o runner preenche): é o que fica guardado esperando o "sim" */
  toolCall?: { name: string; args: Record<string, unknown> };
  /** a pessoa já disse "sim" a esta ação e o servidor está executando o que ficou guardado */
  approvedAction?: boolean;
}

export interface Tool<A = any> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** id da integração necessária; a tool só aparece para o agente se estiver conectada */
  integration?: string;
  /** só o dono da plataforma (OWNER_PHONES) usa: mexe em contas pessoais dele (e-mail, pagamentos, automações) */
  ownerOnly?: boolean;
  run(args: A, ctx: ToolContext): Promise<unknown>;
}

export function defineTool<A>(t: Tool<A>): Tool<A> {
  return t;
}

/** Atalho para JSON Schema de objeto */
export function obj(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

/**
 * Marca as ferramentas que pedem o "sim" da pessoa. Não vai nada para o modelo (quem confirma é o servidor,
 * pela resposta da pessoa) e economiza token em toda chamada; se o modelo mandar confirmed_by_user, é descartado.
 */
export const CONFIRM_PARAM = {};

/**
 * Trava de ação sensível (dinheiro, mensagem para terceiro, apagar). Quem libera é o servidor, não o modelo:
 * a ação fica guardada em pending_actions e só roda quando a próxima mensagem da PESSOA for um "sim"
 * (agent/confirm.ts, sem IA). Assim um texto lido na web ou num e-mail não consegue se autoconfirmar.
 * Devolve null quando pode seguir (execução já aprovada) ou o aviso para o agente pedir a confirmação.
 */
export async function requireConfirmation(_args: { confirmed_by_user?: boolean }, summary: string, ctx?: ToolContext) {
  if (ctx?.approvedAction) return null;
  if (ctx?.toolCall && ctx.conversation?.id) {
    const { confirmed_by_user: _c, ...args } = ctx.toolCall.args as Record<string, unknown>;
    // um pedido por ferramenta: se o agente refez com dados novos, vale o último
    await query("UPDATE pending_actions SET status = 'replaced', resolved_at = now() WHERE conversation_id = $1 AND tool = $2 AND status = 'pending'", [
      ctx.conversation.id,
      ctx.toolCall.name,
    ]);
    await query("INSERT INTO pending_actions (conversation_id, user_id, tool, agent, args, summary) VALUES ($1, $2, $3, $4, $5, $6)", [
      ctx.conversation.id,
      ctx.user.id,
      ctx.toolCall.name,
      ctx.agent,
      JSON.stringify(args),
      summary.slice(0, 500),
    ]);
    // o servidor manda a pergunta com o resumo dele, ao pé da resposta: o "sim" vale para o que a pessoa leu, não para a frase do modelo
    ctx.room?.confirmations?.push(summary.slice(0, 500));
  }
  return {
    needs_confirmation: true,
    message:
      `Ação NÃO executada: precisa do "sim" da pessoa para ${summary}. ` +
      "O sistema manda no fim da sua resposta a pergunta com os detalhes exatos: não repita a pergunta nem os detalhes. " +
      "Quando ela responder sim, o sistema executa sozinho exatamente isso; não chame a ferramenta de novo para confirmar.",
  };
}
