CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Pessoas que falam com o agente (equivalente ao "Trusted people" do Instinct)
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL UNIQUE,
  name text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('active', 'pending', 'blocked')),
  timezone text,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL,
  -- chat id no provedor (ex.: 5519999999999@s.whatsapp.net)
  remote_jid text NOT NULL,
  summary text,
  -- último id de mensagem já incorporado ao resumo
  summary_until bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, remote_jid)
);

CREATE TABLE messages (
  id bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'event')),
  content text NOT NULL DEFAULT '',
  external_id text,
  media jsonb,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  processed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conv_idx ON messages (conversation_id, id DESC);
CREATE INDEX messages_pending_idx ON messages (conversation_id) WHERE processed = false;
CREATE UNIQUE INDEX messages_external_idx ON messages (conversation_id, external_id) WHERE external_id IS NOT NULL;

-- Memória de longo prazo sobre a pessoa (preferências, fatos, contexto)
CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  search tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_search_idx ON memories USING gin (search);
CREATE INDEX memories_user_idx ON memories (user_id, created_at DESC);

CREATE TABLE reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- o que lembrar, em linguagem natural; o agente escreve a mensagem na hora do disparo
  intent text NOT NULL,
  due_at timestamptz,
  cron text,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'done', 'cancelled', 'failed')),
  job_id text,
  last_fired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reminders_user_idx ON reminders (user_id, status);

-- Finanças (núcleo original do Planejai)
CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('expense', 'income')),
  amount numeric(14, 2) NOT NULL CHECK (amount >= 0),
  category text NOT NULL DEFAULT 'Outros',
  description text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transactions_user_idx ON transactions (user_id, occurred_at DESC);

-- Integrações (conectores). Credenciais criptografadas com APP_SECRET (AES-256-GCM).
CREATE TABLE integrations (
  id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  credentials_enc text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  connected_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Execuções e passos: o "Executions" do n8n, para logs detalhados no dashboard
CREATE TABLE executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'error')),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  input text,
  output text,
  error text,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer
);
CREATE INDEX executions_started_idx ON executions (started_at DESC);

CREATE TABLE execution_steps (
  id bigserial PRIMARY KEY,
  execution_id uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  parent_id bigint REFERENCES execution_steps(id) ON DELETE CASCADE,
  agent text NOT NULL,
  type text NOT NULL CHECK (type IN ('llm', 'tool', 'delegate', 'channel', 'info')),
  name text NOT NULL,
  model text,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'error')),
  input jsonb,
  output jsonb,
  error text,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer
);
CREATE INDEX execution_steps_exec_idx ON execution_steps (execution_id, id);

-- Modelo escolhido por agente/tarefa (sobrescreve os padrões do código)
CREATE TABLE model_routes (
  task text PRIMARY KEY,
  model text NOT NULL,
  fallbacks text[] NOT NULL DEFAULT '{}',
  temperature real,
  max_tokens integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
