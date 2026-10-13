-- Enquete "Sim / Não" que pede o "sim" de uma ação sensível no WhatsApp (whatsapp/polls.ts).
-- Guarda a chave da enquete: o voto chega criptografado e só abre com ela. Vale 30 min, como pending_actions.
CREATE TABLE IF NOT EXISTS wa_polls (
  message_id text PRIMARY KEY,
  remote_jid text NOT NULL,
  secret text NOT NULL,
  options jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);
CREATE INDEX IF NOT EXISTS wa_polls_jid ON wa_polls (remote_jid, created_at);
