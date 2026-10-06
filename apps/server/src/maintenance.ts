import { summarizeConversation } from "./agent/orchestrator.js";
import { config } from "./config.js";
import { many, query } from "./db/pool.js";

/**
 * Limpeza periódica (de hora em hora, no worker):
 * - mensagens com mais de MESSAGE_RETENTION_HOURS viram resumo da conversa e são apagadas
 *   (a memória curta no Redis expira sozinha no mesmo prazo; gastos, memórias e lembretes ficam);
 * - logs de execução e gravações antigas saem depois de EXECUTION_RETENTION_DAYS.
 */
export async function purgeOld(log?: { info: (...a: any[]) => void; error: (...a: any[]) => void }) {
  const hours = config.MESSAGE_RETENTION_HOURS;
  const convs = await many<{ conversation_id: string; max_id: string }>(
    `SELECT m.conversation_id, MAX(m.id) AS max_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.created_at < now() - make_interval(hours => $1) AND m.processed = true AND m.id > c.summary_until
      GROUP BY m.conversation_id`,
    [hours],
  );
  for (const c of convs) {
    try {
      await summarizeConversation(c.conversation_id, { upTo: Number(c.max_id) });
    } catch (err) {
      // sem resumo não apaga: tenta de novo na próxima rodada
      log?.error({ err, conversationId: c.conversation_id }, "falha ao resumir antes de limpar");
    }
  }
  const msgs = await query(
    `DELETE FROM messages m USING conversations c
      WHERE c.id = m.conversation_id AND m.created_at < now() - make_interval(hours => $1) AND m.processed = true AND m.id <= c.summary_until`,
    [hours],
  );
  const execs = await query("DELETE FROM executions WHERE started_at < now() - make_interval(days => $1)", [config.EXECUTION_RETENTION_DAYS]);
  const files = await query("DELETE FROM media_files WHERE created_at < now() - make_interval(days => $1)", [config.EXECUTION_RETENTION_DAYS]);
  const out = { messages: msgs.rowCount ?? 0, executions: execs.rowCount ?? 0, files: files.rowCount ?? 0 };
  log?.info(out, "limpeza de dados antigos");
  return out;
}
