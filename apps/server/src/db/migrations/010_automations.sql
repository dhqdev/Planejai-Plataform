-- Automações que o assistente cria no n8n a pedido de cada pessoa (o fluxo mora no n8n; aqui fica de quem é)
CREATE TABLE IF NOT EXISTS automations (
  workflow_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automations_user ON automations (user_id);
