-- Agenda com tags: o compromisso guarda título curto, horário do compromisso (o lembrete pode sair antes),
-- tag (assunto) e cor. As tags de cada pessoa ficam guardadas para o assistente reaproveitar.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS event_at timestamptz;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS tag text;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS color text;

CREATE TABLE IF NOT EXISTS agenda_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS agenda_tags_user_name_idx ON agenda_tags (user_id, lower(name));

-- compromissos que os recados já marcaram: o bloco vai para o horário do compromisso, com o nome do lugar
UPDATE reminders r SET title = e.place, event_at = e.appointment_at
  FROM errands e
 WHERE r.user_id = e.user_id AND r.title IS NULL AND e.appointment_at IS NOT NULL
   AND r.intent LIKE 'Compromisso marcado pelo assistente com ' || e.place || ' às %';
