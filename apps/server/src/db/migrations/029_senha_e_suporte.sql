-- Código de login também serve para "esqueci a senha": o propósito separa um do outro
ALTER TABLE login_codes ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'login';

-- Pedidos de falar com o responsável pela plataforma, feitos ao assistente
CREATE TABLE IF NOT EXISTS support_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic text NOT NULL,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);
CREATE INDEX IF NOT EXISTS support_requests_open ON support_requests (status, created_at DESC);
