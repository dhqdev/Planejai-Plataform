-- Índices que faltavam para as telas que mais abrem (2026-10-19): a conversa de cada pessoa (chat do Início, a cada
-- poucos segundos, e quase toda consulta "da pessoa" passa por conversations.user_id) e as execuções por pessoa e por
-- conversa (Pessoas > ficha, filtro de Execuções). As tabelas são pequenas: cria na hora, sem CONCURRENTLY.
CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations (user_id);
CREATE INDEX IF NOT EXISTS executions_user_idx ON executions (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS executions_conv_idx ON executions (conversation_id, started_at DESC);
