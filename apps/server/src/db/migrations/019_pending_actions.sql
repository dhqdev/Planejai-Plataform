-- Ações sensíveis esperando o "sim" da pessoa (enviar e-mail, apagar lançamentos, disparar n8n...).
-- Quem confirma é o servidor, lendo a resposta da pessoa: o modelo não consegue se autoconfirmar
-- (antes valia o campo confirmed_by_user que o próprio modelo preenchia, e uma página lida podia induzir isso).
CREATE TABLE IF NOT EXISTS pending_actions (
  id bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool text NOT NULL,
  agent text NOT NULL,
  args jsonb NOT NULL,
  summary text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS pending_actions_open ON pending_actions (conversation_id, created_at) WHERE status = 'pending';
