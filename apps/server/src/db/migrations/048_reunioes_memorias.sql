-- "O que ele sabe de mim": cada fato ganha um assunto (categoria) e de onde veio (conversa, reunião ou a própria pessoa).
ALTER TABLE memories ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'conversa';
UPDATE memories SET category = 'perfil' WHERE category IS NULL AND 'perfil' = ANY(tags);

-- Ata de cada reunião das 19h: o que o time aprendeu e mudou para a pessoa (sem guardar a conversa)
CREATE TABLE IF NOT EXISTS improve_meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  execution_id uuid REFERENCES executions(id) ON DELETE SET NULL,
  asks int NOT NULL DEFAULT 0,
  summary text,
  learned jsonb NOT NULL DEFAULT '[]',
  changes jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS improve_meetings_user_idx ON improve_meetings (user_id, created_at DESC);
