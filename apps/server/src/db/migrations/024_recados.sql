-- Recados: o assistente conversa com um estabelecimento pelo WhatsApp em nome da pessoa (errands.ts).
CREATE TABLE IF NOT EXISTS errands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  place text NOT NULL,
  phone text NOT NULL,
  jid text NOT NULL,
  goal text NOT NULL,
  allowed text,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'asking', 'done', 'failed', 'cancelled', 'expired')),
  question text,
  outcome text,
  appointment_at timestamptz,
  log jsonb NOT NULL DEFAULT '[]',
  sent integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS errands_open_phone_idx ON errands (phone) WHERE status IN ('waiting', 'asking');
CREATE INDEX IF NOT EXISTS errands_user_idx ON errands (user_id, created_at DESC);
