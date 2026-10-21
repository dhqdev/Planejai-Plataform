-- Uber pelo WhatsApp (beta): sessão do m.uber.com de cada pessoa (cookies cifrados) e as corridas pedidas por ela
CREATE TABLE IF NOT EXISTS uber_sessions (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- cookies do m.uber.com/auth.uber.com (encryptJson); some ao desconectar
  state_enc text,
  status text NOT NULL DEFAULT 'nova' CHECK (status IN ('nova', 'ok', 'vencida')),
  -- o robô está esperando um código ('sms' ou 'email'): a próxima mensagem só com dígitos vai para ele, sem IA
  waiting_code text CHECK (waiting_code IN ('sms', 'email')),
  waiting_since timestamptz,
  code_enc text,
  -- Atalho do iPhone (ou app do Android) que encaminha o SMS da Uber: só o hash do token fica aqui
  shortcut_hash text UNIQUE,
  logged_at timestamptz,
  last_used_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS uber_rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  execution_id uuid REFERENCES executions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'cotando' CHECK (status IN ('cotando', 'opcoes', 'pedindo', 'pedida', 'erro', 'vencida')),
  pickup text NOT NULL,
  dropoff text NOT NULL,
  -- como a Uber entendeu os endereços
  pickup_label text,
  dropoff_label text,
  -- [{ n, name, price_cents, price_max_cents, price_text, eta }]
  options jsonb NOT NULL DEFAULT '[]',
  chosen jsonb,
  driver jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS uber_rides_user_idx ON uber_rides (user_id, created_at DESC);
