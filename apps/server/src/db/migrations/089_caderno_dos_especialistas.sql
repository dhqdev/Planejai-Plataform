-- Caderno dos especialistas sob medida: o que precisa durar entre uma conversa e outra (presença do dia,
-- valores combinados, quem pagou). O quadro do time (share_with_team) some no fim de cada execução, e o
-- "Ponto" do Rico dizia "registrado" sem ter guardado nada (2026-11-03).
CREATE TABLE agent_notebook (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_agent_id uuid NOT NULL REFERENCES client_agents(id) ON DELETE CASCADE,
  day date,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_notebook_agent ON agent_notebook (client_agent_id, created_at DESC);
