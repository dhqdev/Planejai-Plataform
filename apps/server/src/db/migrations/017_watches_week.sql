-- Acompanhamentos: duram 1 semana por padrão e contam o resultado de cada olhada (achou ou não)
ALTER TABLE watches ALTER COLUMN expires_at SET DEFAULT now() + interval '7 days';
ALTER TABLE watches ADD COLUMN IF NOT EXISTS notify_mode text NOT NULL DEFAULT 'always' CHECK (notify_mode IN ('always', 'changes'));
ALTER TABLE watches ADD COLUMN IF NOT EXISTS checks integer NOT NULL DEFAULT 0;
ALTER TABLE watches ADD COLUMN IF NOT EXISTS last_check_at timestamptz;
ALTER TABLE watches ADD COLUMN IF NOT EXISTS last_result jsonb;
ALTER TABLE watches ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;
ALTER TABLE watches ADD COLUMN IF NOT EXISTS ended_notice boolean NOT NULL DEFAULT false;
