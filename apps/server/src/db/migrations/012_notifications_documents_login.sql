-- Notificações do painel (bolinha no menu). user_id NULL = para o dono da stack.
CREATE TABLE IF NOT EXISTS notifications (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread ON notifications (user_id) WHERE read_at IS NULL;

-- Documentos guardados pela pessoa (PDF, imagens, planilhas): o assistente salva e manda de volta quando pedir
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  mimetype text NOT NULL,
  size integer NOT NULL,
  data bytea NOT NULL,
  folder text,
  notes text,
  source text NOT NULL DEFAULT 'painel',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_user ON documents (user_id, created_at DESC);

-- Login em navegador novo: código no WhatsApp. Aparelhos confiáveis ficam guardados (hash do cookie).
CREATE TABLE IF NOT EXISTS login_devices (
  account_id text NOT NULL,
  device_hash text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, device_hash)
);
CREATE TABLE IF NOT EXISTS login_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
