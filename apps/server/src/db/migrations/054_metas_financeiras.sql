-- Metas financeiras: "juntar R$ 2.000 até dezembro". O Moacir acompanha; cada valor guardado ou tirado fica no histórico.
CREATE TABLE IF NOT EXISTS finance_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  target numeric(14, 2) NOT NULL CHECK (target > 0),
  saved numeric(14, 2) NOT NULL DEFAULT 0 CHECK (saved >= 0),
  deadline date,
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_goals_user_idx ON finance_goals (user_id, created_at);
CREATE TABLE IF NOT EXISTS finance_goal_moves (
  id bigserial PRIMARY KEY,
  goal_id uuid NOT NULL REFERENCES finance_goals(id) ON DELETE CASCADE,
  amount numeric(14, 2) NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_goal_moves_goal_idx ON finance_goal_moves (goal_id, created_at DESC);

-- Economia saiu da loja de especialistas: metas agora moram em Finanças, com o Moacir
UPDATE client_agents SET active = false, updated_at = now() WHERE origin = 'loja' AND slug = 'economia';
-- cada especialista da loja veste a roupa dele (skin:<slug>), não uma roupa sorteada
UPDATE client_agents SET face = jsonb_build_object('color', COALESCE((face->>'color')::int, 5), 'eyes', 'happy', 'mouth', 'smile', 'extra', 'skin:' || slug)
 WHERE origin = 'loja';
