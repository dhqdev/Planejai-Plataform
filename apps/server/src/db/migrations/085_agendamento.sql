-- Link público de agendamento (estilo Calendly): cada pessoa tem uma página /agendar/<slug> para pôr na bio do Instagram.
-- O cliente dela escolhe serviço, dia e horário livre, preenche nome, WhatsApp e e-mail, e o horário cai na Agenda dela.
CREATE TABLE IF NOT EXISTS booking_pages (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  slug text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  -- nome que aparece na página (estabelecimento ou a própria pessoa) e uma frase curta
  title text NOT NULL,
  about text,
  -- [{ id, name, minutes }]
  services jsonb NOT NULL DEFAULT '[]',
  -- horários por dia da semana (0 = domingo): { "1": [["09:00","12:00"],["13:00","18:00"]], ... }
  hours jsonb NOT NULL DEFAULT '{}',
  -- de quanto em quanto tempo começa um horário, folga entre atendimentos, antecedência mínima e até quantos dias à frente
  step_min int NOT NULL DEFAULT 30,
  buffer_min int NOT NULL DEFAULT 0,
  notice_min int NOT NULL DEFAULT 120,
  days_ahead int NOT NULL DEFAULT 30,
  -- aviso da dona no WhatsApp (minutos antes) e avisos do cliente
  owner_lead_min int NOT NULL DEFAULT 60,
  client_leads int[] NOT NULL DEFAULT '{1440,120}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service text NOT NULL,
  minutes int NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  client_name text NOT NULL,
  client_phone text NOT NULL,
  client_email text,
  note text,
  status text NOT NULL DEFAULT 'confirmado' CHECK (status IN ('confirmado', 'desmarcado')),
  -- quem desmarcou: 'cliente' (pelo link) ou 'dono' (pela agenda)
  cancelled_by text,
  -- link do cliente para ver e desmarcar (sem login)
  token text NOT NULL UNIQUE,
  -- o compromisso na Agenda da dona (lembrete com aviso); some quando o aviso dispara
  reminder_id uuid REFERENCES reminders(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz
);
CREATE INDEX IF NOT EXISTS bookings_user_start ON bookings (user_id, start_at) WHERE status = 'confirmado';
CREATE INDEX IF NOT EXISTS bookings_reminder ON bookings (reminder_id) WHERE reminder_id IS NOT NULL;

-- compromisso com duração própria (agendamento de 45 min, por exemplo); sem valor, a agenda usa 1 h
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS event_minutes int;
