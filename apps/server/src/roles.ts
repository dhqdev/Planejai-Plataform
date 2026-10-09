import { config } from "./config.js";

/**
 * Papéis do processo (ROLE):
 * - all: tudo num processo só (docker-compose, testes).
 * - api: painel e webhooks.
 * - worker: canal + conversas (stack padrão, 1 réplica).
 * - channel: 1 réplica. Segura o WhatsApp (aluguel em whatsapp/lease.ts), recebe, envia (filas outbound,
 *   convite e whatsapp.send), Telegram por polling e TODOS os jobs agendados (limpeza, De olho, reunião noturna,
 *   contas do dia): um dono só para o cron, sem disputa entre réplicas.
 * - conversations: N réplicas. Só filas de conversa, lembrete, recado e resumo; envia pelo channel (whatsapp/rpc.ts).
 */
export type Role = typeof config.ROLE;

/** Segura o WhatsApp, faz os envios e os jobs agendados. */
export const runsChannel = (role: Role = config.ROLE) => role === "all" || role === "worker" || role === "channel";

/** Consome as filas de conversa (process, lembrete, recado, resumo). */
export const runsConversations = (role: Role = config.ROLE) => role === "all" || role === "worker" || role === "conversations";

export const runsApi = (role: Role = config.ROLE) => role === "all" || role === "api";
