-- Roupinha do Mochi (mascote do app) de cada conta
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS mascot jsonb;
