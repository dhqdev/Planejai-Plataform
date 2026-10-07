import { summarizeConversation } from "./agent/orchestrator.js";
import { config } from "./config.js";
import { many, query } from "./db/pool.js";
import { redisAlive } from "./shortmem.js";

/**
 * Limpeza periódica (de hora em hora, no worker):
 * - mensagens com mais de MESSAGE_RETENTION_HOURS viram resumo da conversa e são apagadas
 *   (a memória curta no Redis expira sozinha no mesmo prazo; gastos, memórias e lembretes ficam);
 * - o texto dos logs de execução sai depois de LOG_CONTENT_HOURS (fica só custo/tempo/modelo);
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
  // Memória curta no Redis expira em MESSAGE_RETENTION_HOURS: resume antes o que está perto de sumir
  if (await redisAlive()) {
    const recent = await many<{ id: string }>("SELECT id FROM conversations WHERE updated_at > now() - make_interval(hours => $1)", [hours + 2]);
    for (const c of recent) {
      await summarizeConversation(c.id, { olderThanMs: Math.max(1, hours - 3) * 3600_000 }).catch((err) =>
        log?.error({ err, conversationId: c.id }, "falha ao resumir memória curta"),
      );
    }
  }
  const msgs = await query(
    `DELETE FROM messages m USING conversations c
      WHERE c.id = m.conversation_id AND m.created_at < now() - make_interval(hours => $1) AND m.processed = true AND m.id <= c.summary_until`,
    [hours],
  );
  // Conversa não fica guardada: depois de LOG_CONTENT_HOURS o log perde o texto e fica só a métrica
  const scrubbed = await query(
    `WITH old AS (
       UPDATE executions SET input = NULL, output = NULL, content_purged = true
        WHERE NOT content_purged AND started_at < now() - make_interval(hours => $1) RETURNING id
     )
     UPDATE execution_steps s SET input = NULL, output = NULL FROM old WHERE s.execution_id = old.id`,
    [config.LOG_CONTENT_HOURS],
  );
  const execs = await query("DELETE FROM executions WHERE started_at < now() - make_interval(days => $1)", [config.EXECUTION_RETENTION_DAYS]);
  const files = await query("DELETE FROM media_files WHERE created_at < now() - make_interval(days => $1)", [config.EXECUTION_RETENTION_DAYS]);
  // lembrete que já passou ou foi cancelado não serve mais para nada
  const rems = await query("DELETE FROM reminders WHERE status IN ('done', 'cancelled') OR (status = 'failed' AND created_at < now() - interval '7 days')");
  const out = { messages: msgs.rowCount ?? 0, logSteps: scrubbed.rowCount ?? 0, executions: execs.rowCount ?? 0, files: files.rowCount ?? 0, reminders: rems.rowCount ?? 0 };
  log?.info(out, "limpeza de dados antigos");
  return out;
}
