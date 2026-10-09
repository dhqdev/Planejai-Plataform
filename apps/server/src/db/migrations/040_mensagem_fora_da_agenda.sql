-- Mensagem avulsa que já saiu (ou falhou) pode sair da Agenda sem mudar o status: a resposta do contato
-- continua voltando para quem mandou (handleDirectReply olha status = 'sent').
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
