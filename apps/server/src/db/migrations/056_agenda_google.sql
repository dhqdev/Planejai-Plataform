-- Compromisso do Planejai espelhado no Google Agenda de quem conectou (calendar-sync.ts): criar, mudar e apagar acompanham.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS google_event_id text;
