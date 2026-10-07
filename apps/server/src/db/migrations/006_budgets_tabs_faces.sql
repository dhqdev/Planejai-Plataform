-- Limites de gastos por mês: category NULL = limite do total
CREATE TABLE budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text,
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  -- último aviso dado (mês AAAA-MM e nível 80/100) para não repetir
  alerted_month text,
  alerted_level integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX budgets_user_category_idx ON budgets (user_id, COALESCE(category, '*'));

-- Reunião noturna do CTO: como falar com cada pessoa e o que cada agente aprendeu sobre ela
ALTER TABLE users ADD COLUMN style_notes text;
-- abas do app de cada pessoa (começa só com o essencial; a reunião noturna libera mais)
ALTER TABLE users ADD COLUMN app_tabs jsonb;
CREATE TABLE agent_notes (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent text NOT NULL,
  note text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, agent)
);

-- Agentes criados para clientes ganham apelido e carinha
ALTER TABLE client_agents ADD COLUMN persona text;
ALTER TABLE client_agents ADD COLUMN face jsonb;
