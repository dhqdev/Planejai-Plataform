-- Conexão própria do WhatsApp (Baileys): credenciais e chaves Signal ficam no banco,
-- então a sessão sobrevive a redeploys sem precisar de volume.
CREATE TABLE wa_auth (
  session text NOT NULL,
  key text NOT NULL,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session, key)
);

CREATE TABLE wa_sessions (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('disconnected', 'connecting', 'qr', 'pairing', 'connected')),
  qr text,
  pairing_code text,
  phone text,
  name text,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO wa_sessions (id) VALUES ('default');
