-- Esteira que aprende: depois de cada chamado que termina, a retrospectiva (devpipeline/pipeline.ts retrospective)
-- grava lições curtas por agente (Lia, Beto, Caio, Vera, Tito) que entram no prompt dele nos próximos chamados.
-- weight sobe quando a mesma lição se repete; o dono pode apagar uma lição ruim no painel do time.
CREATE TABLE IF NOT EXISTS dev_lessons (
  id serial PRIMARY KEY,
  agent text NOT NULL,
  lesson text NOT NULL,
  ticket_id int REFERENCES dev_tickets(id) ON DELETE SET NULL,
  weight int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dev_lessons_agent_idx ON dev_lessons (agent, weight DESC, updated_at DESC);
-- retrospectiva roda uma vez por chamado (job repetido não duplica)
ALTER TABLE dev_tickets ADD COLUMN IF NOT EXISTS retro_at timestamptz;
