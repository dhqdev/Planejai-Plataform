-- Mensagem avulsa para qualquer número (cliente, restaurante...), agora ou agendada, sem convite de cadastro.
CREATE TABLE IF NOT EXISTS direct_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text,
  phone text NOT NULL,
  jid text,
  text text NOT NULL,
  send_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'scheduled',
  sent_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS direct_messages_user_idx ON direct_messages (user_id, status, send_at);
CREATE INDEX IF NOT EXISTS direct_messages_phone_idx ON direct_messages (phone, sent_at);
