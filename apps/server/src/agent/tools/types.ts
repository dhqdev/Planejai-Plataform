import type { Channel, OutboundImage } from "../../channels/types.js";
import type { TeamRoom } from "../collab.js";
import type { Guard } from "../guard.js";
import type { Tracer } from "../trace.js";

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
  /** avisos de andamento e "digitando..." para a pessoa enquanto o time trabalha */
  progress?: import("../progress.js").Progress;
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

export const CONFIRM_PARAM = {
  confirmed_by_user: {
    type: "boolean",
    description: "true somente se a pessoa confirmou explicitamente esta ação nesta conversa",
  },
};

export function requireConfirmation(args: { confirmed_by_user?: boolean }, summary: string) {
  if (!args.confirmed_by_user) {
    return {
      needs_confirmation: true,
      message: `Ação não executada. Peça confirmação explícita à pessoa antes: ${summary}`,
    };
  }
  return null;
}
