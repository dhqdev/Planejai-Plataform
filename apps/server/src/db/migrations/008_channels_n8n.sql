-- Outros canais além do WhatsApp (Telegram): qual conta do canal é qual pessoa
CREATE TABLE IF NOT EXISTS channel_links (
  channel text NOT NULL,
  external_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, external_id)
);
CREATE INDEX IF NOT EXISTS channel_links_user ON channel_links (user_id);

-- Códigos de uso único para ligar a conta pelo painel (t.me/bot?start=CODIGO)
CREATE TABLE IF NOT EXISTS link_codes (
  code text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL,
  expires_at timestamptz NOT NULL
);
