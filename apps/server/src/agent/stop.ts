import { many, one } from "../db/pool.js";
import type { Guard } from "./guard.js";

/** "para", "cancela", "esquece isso"... sozinho, enquanto o assistente ainda está trabalhando. */
const STOP_WORDS = /^\s*(para|pare|parar|para tudo|para isso|pode parar|cancela|cancelar|cancela isso|esquece|esquece isso|deixa pra l[aá]|stop)\s*[!.]*\s*$/i;

export function isStopCommand(text: string | null | undefined) {
  return Boolean(text && STOP_WORDS.test(text));
}

/** Pede para parar uma execução em andamento (botão Parar em Execuções). false = ela já terminou. */
export async function requestStop(executionId: string) {
  return Boolean(await one("UPDATE executions SET stop_requested_at = now() WHERE id = $1 AND status = 'running' RETURNING id", [executionId]));
}

/** Para tudo que está rodando nesta conversa (a pessoa mandou "para" no WhatsApp). Devolve quantas. */
export async function stopConversationRuns(conversationId: string) {
  const rows = await many(
    "UPDATE executions SET stop_requested_at = now() WHERE conversation_id = $1 AND status = 'running' AND stop_requested_at IS NULL RETURNING id",
    [conversationId],
  );
  return rows.length;
}

/**
 * Confere a cada 2 s se alguém pediu para parar (o pedido pode vir de outro processo: API, outra réplica).
 * Pedido visto: o Guard cancela o que estiver em andamento (LLM, ferramentas, navegador) e o time responde parado.
 */
export function watchStop(executionId: string, guard: Guard, everyMs = 2000) {
  const timer = setInterval(async () => {
    const row = await one("SELECT stop_requested_at FROM executions WHERE id = $1", [executionId]).catch(() => null);
    if (row?.stop_requested_at) {
      guard.stop();
      clearInterval(timer);
    }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
