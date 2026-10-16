-- Secretária de reuniões (meet.ts): o painel no notebook capta o áudio da guia do Meet em trechos,
-- cada trecho vira texto (o áudio sai do banco logo depois) e no fim sai a ata em PDF.
CREATE TABLE IF NOT EXISTS meet_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  -- gravando | resumindo | pronto | erro
  status text NOT NULL DEFAULT 'gravando',
  execution_id uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  summary text,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  error text
);
CREATE INDEX IF NOT EXISTS meet_sessions_user ON meet_sessions (user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS meet_chunks (
  session_id uuid NOT NULL REFERENCES meet_sessions(id) ON DELETE CASCADE,
  seq int NOT NULL,
  audio bytea,
  mimetype text,
  transcript text,
  -- pendente | pronto | erro
  status text NOT NULL DEFAULT 'pendente',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);
