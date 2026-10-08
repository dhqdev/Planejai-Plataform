-- Integrações por pessoa: cada cliente conecta a própria conta (Google, Notion, GitHub, Linear, Slack).
-- Credenciais criptografadas como as da plataforma; o app OAuth do Google continua o do dono (integrations.google).
CREATE TABLE IF NOT EXISTS user_integrations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  integration_id text NOT NULL,
  credentials_enc text NOT NULL,
  label text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, integration_id)
);
