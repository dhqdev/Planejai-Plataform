-- Arquivo (PDF, foto, vídeo) que um contato mandou na conversa com o assistente: fica guardado em Documentos
-- (pasta "Recados") e a conversa da tela Recados mostra o arquivo no balão (pedido do David em 2026-11-11).
-- Nos recados com estabelecimentos o mesmo dado vai dentro de cada item do errands.log (campo "file").
ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS file jsonb;
