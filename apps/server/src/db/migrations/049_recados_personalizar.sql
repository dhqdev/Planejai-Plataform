-- Recados: jeito de cada conversa (apelido, cor, tom, assinatura, fixar, arquivar) e o acompanhamento dela (chatprefs.ts).
CREATE TABLE IF NOT EXISTS chat_prefs (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone text NOT NULL,
  nickname text,
  color text,
  tone text,
  signature text,
  note text,
  pinned boolean NOT NULL DEFAULT false,
  archived boolean NOT NULL DEFAULT false,
  -- auto: respostas voltam até 72h depois da última mensagem; on: sem prazo; off: não voltam mais
  follow text NOT NULL DEFAULT 'auto' CHECK (follow IN ('auto', 'on', 'off')),
  -- "excluir acompanhamento": o que aconteceu antes disso some da tela
  removed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, phone)
);
CREATE INDEX IF NOT EXISTS chat_prefs_follow_idx ON chat_prefs (phone) WHERE follow = 'on';
ALTER TABLE errands ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
