-- Conversa delegada (errands.ts, kind = 'conversa'): o dono pede e um agente do time conversa de verdade com
-- uma pessoa de fora (ex.: alguém passando mal conversa com a Saúde). agent = slug do especialista que fala.
ALTER TABLE errands ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'recado';
ALTER TABLE errands ADD COLUMN IF NOT EXISTS agent text;
ALTER TABLE errands ADD COLUMN IF NOT EXISTS alerted_at timestamptz;

-- Quem chega de fora sem ser cliente recebe uma mensagem fixa para assinar, no máximo uma vez por semana (outreach.ts).
CREATE TABLE IF NOT EXISTS stranger_notices (
  phone text PRIMARY KEY,
  sent_at timestamptz NOT NULL DEFAULT now()
);
