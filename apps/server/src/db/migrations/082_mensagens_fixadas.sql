-- O que o assistente fixou no chat ([[fixar]]): desafixa sozinho depois de 7 dias e diz quando a última lista de compras foi mexida
CREATE TABLE IF NOT EXISTS pinned_messages (
  id bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  kind text NOT NULL DEFAULT 'fixado',
  pinned_at timestamptz NOT NULL DEFAULT now(),
  unpinned_at timestamptz
);
CREATE INDEX IF NOT EXISTS pinned_messages_conv_idx ON pinned_messages (conversation_id, kind, pinned_at DESC);
CREATE INDEX IF NOT EXISTS pinned_messages_open_idx ON pinned_messages (pinned_at) WHERE unpinned_at IS NULL;
