-- Ligações de verdade saem do Planejai (o alarme continua tocando no celular pela notificação).
ALTER TABLE reminders DROP COLUMN IF EXISTS call_text;
ALTER TABLE alarms DROP COLUMN IF EXISTS call;
DROP TABLE IF EXISTS alarm_calls;
UPDATE users SET profile = profile - 'alarm_mode' WHERE profile ? 'alarm_mode';
