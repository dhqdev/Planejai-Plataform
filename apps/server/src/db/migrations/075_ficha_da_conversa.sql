-- Ficha de cada conversa de Recados (2026-10-19): o que precisa ser guardado para guiar o assistente
-- (nome, o que a pessoa quer, valores cotados, horário...). Lista de { label, value }.
ALTER TABLE chat_prefs ADD COLUMN IF NOT EXISTS facts jsonb NOT NULL DEFAULT '[]'::jsonb;
