-- Arquivos fora do banco: com storage S3 (R2) ligado, o conteúdo vai pro bucket e a linha guarda só metadados + chave.
-- Linhas antigas continuam com data (bytea) até a limpeza de hora em hora levar para o bucket.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS storage_key text;
ALTER TABLE documents ALTER COLUMN data DROP NOT NULL;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS storage_key text;
ALTER TABLE media_files ALTER COLUMN data DROP NOT NULL;

-- Objeto cuja linha sumiu (inclusive em cascata: execução ou pessoa apagada) espera aqui para sair do bucket
CREATE TABLE IF NOT EXISTS storage_trash (
  key text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION storage_trash_on_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.storage_key IS NOT NULL THEN
    INSERT INTO storage_trash (key) VALUES (OLD.storage_key) ON CONFLICT DO NOTHING;
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER documents_storage_trash AFTER DELETE ON documents FOR EACH ROW EXECUTE FUNCTION storage_trash_on_delete();
CREATE TRIGGER media_files_storage_trash AFTER DELETE ON media_files FOR EACH ROW EXECUTE FUNCTION storage_trash_on_delete();
