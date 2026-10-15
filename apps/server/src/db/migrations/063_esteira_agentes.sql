-- Esteira com um agente por coluna (Lia, Beto, Caio, Vera, Tito: devpipeline/pipeline.ts AGENTS).
-- kind 'msg' = recado de um agente para outro (ou para o dono), que aparece como conversa no card.
ALTER TABLE dev_ticket_steps ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'step';
ALTER TABLE dev_ticket_steps ADD COLUMN IF NOT EXISTS agent text;
ALTER TABLE dev_ticket_steps ADD COLUMN IF NOT EXISTS to_agent text;
