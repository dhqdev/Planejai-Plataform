-- Ligação pelo Twilio também em lembrete (texto falado na hora) e por alarme (sem depender da escolha geral da pessoa)
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS call_text text;
ALTER TABLE alarms ADD COLUMN IF NOT EXISTS call boolean NOT NULL DEFAULT false;
-- de qual lembrete veio a ligação (sem chave estrangeira: o lembrete único some depois de disparar); evita ligar duas vezes se o job repetir
ALTER TABLE alarm_calls ADD COLUMN IF NOT EXISTS reminder_id uuid;
CREATE INDEX IF NOT EXISTS alarm_calls_reminder_idx ON alarm_calls (reminder_id, created_at) WHERE reminder_id IS NOT NULL;
