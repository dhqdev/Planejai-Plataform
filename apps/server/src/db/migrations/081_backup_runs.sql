-- Backup feito pelo próprio app no bucket (backup.ts): cada rodada com tamanho, ficha e o que foi conferido
CREATE TABLE IF NOT EXISTS backup_runs (
  id bigserial PRIMARY KEY,
  reason text NOT NULL DEFAULT 'agenda',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok boolean,
  key text,
  bytes bigint,
  error text,
  manifest jsonb
);
CREATE INDEX IF NOT EXISTS backup_runs_started_idx ON backup_runs (started_at DESC);
