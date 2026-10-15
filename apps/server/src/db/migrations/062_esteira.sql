-- Esteira de desenvolvimento (só o dono): um chamado passa sozinho por entender, planejar, codar, revisar,
-- abrir PR e esperar o CI (devpipeline/pipeline.ts). Cada chamada de modelo vira uma linha em dev_ticket_steps
-- com o custo, que fica mesmo depois que o log de Execuções some (painel de custos da esteira).
CREATE TABLE IF NOT EXISTS dev_tickets (
  id serial PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL,
  kind text NOT NULL DEFAULT 'melhoria',
  -- fila, entendendo, planejando, codando, revisando, abrindo_pr, testando, corrigindo, pronto, precisa_de_voce, falhou, cancelado
  stage text NOT NULL DEFAULT 'fila',
  spec jsonb,
  plan jsonb,
  -- arquivos que o modelo escreveu (caminho + conteúdo novo; null = apagar), aplicados no branch
  changes jsonb,
  review jsonb,
  branch text,
  pr_number int,
  pr_url text,
  head_sha text,
  ci jsonb,
  fix_rounds int NOT NULL DEFAULT 0,
  review_rounds int NOT NULL DEFAULT 0,
  error text,
  -- etapa em que parou (falhou/precisa_de_voce): "Tentar de novo" volta para ela
  failed_stage text,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  tokens_in int NOT NULL DEFAULT 0,
  tokens_out int NOT NULL DEFAULT 0,
  stage_started_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS dev_tickets_created_idx ON dev_tickets (created_at DESC);

CREATE TABLE IF NOT EXISTS dev_ticket_steps (
  id serial PRIMARY KEY,
  ticket_id int NOT NULL REFERENCES dev_tickets(id) ON DELETE CASCADE,
  stage text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'success',
  model text,
  tokens_in int NOT NULL DEFAULT 0,
  tokens_out int NOT NULL DEFAULT 0,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  duration_ms int NOT NULL DEFAULT 0,
  summary text,
  detail jsonb,
  execution_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dev_ticket_steps_ticket_idx ON dev_ticket_steps (ticket_id, id);
CREATE INDEX IF NOT EXISTS dev_ticket_steps_created_idx ON dev_ticket_steps (created_at);
