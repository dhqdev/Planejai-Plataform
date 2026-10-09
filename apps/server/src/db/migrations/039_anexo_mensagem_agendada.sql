-- Mensagem avulsa/agendada com foto ou documento junto. O arquivo fica aqui só até sair (ou ser cancelada).
ALTER TABLE direct_messages
  ADD COLUMN IF NOT EXISTS media bytea,
  ADD COLUMN IF NOT EXISTS media_kind text,
  ADD COLUMN IF NOT EXISTS media_mimetype text,
  ADD COLUMN IF NOT EXISTS media_name text;
