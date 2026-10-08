-- Foto diária do tamanho da plataforma (tela Servidor > Armazenamento): uma linha por dia, atualizada de hora em hora.
CREATE TABLE IF NOT EXISTS storage_daily (
  day date PRIMARY KEY,
  db_bytes bigint NOT NULL DEFAULT 0,
  files_bytes bigint NOT NULL DEFAULT 0,
  redis_bytes bigint NOT NULL DEFAULT 0,
  disk_used bigint,
  disk_total bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);
