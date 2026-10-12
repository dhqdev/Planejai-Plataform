-- Categorias de gastos de cada pessoa: criar, renomear, trocar a cor e excluir (os lançamentos vão para outra).
-- Quem nunca mexeu ganha as 14 de sempre na primeira vez que precisa (categories.ts, ensureCategories).
CREATE TABLE IF NOT EXISTS finance_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#9AA0A6',
  -- expense, income ou both: em qual lado aparece no painel e no palpite automático
  kind text NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'income', 'both')),
  -- palavras que a pessoa disse que são dessa categoria ("ração, veterinário, petshop")
  keywords text[] NOT NULL DEFAULT '{}',
  -- nomes antigos e categorias que foram juntadas nesta: o palpite e o modelo ainda acham por eles
  aliases text[] NOT NULL DEFAULT '{}',
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_categories_name_idx ON finance_categories (user_id, lower(name));

-- O que a pessoa corrigiu: "iFood é Delivery". Lançamentos parecidos depois seguem a última escolha.
CREATE TABLE IF NOT EXISTS category_learned (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  kind text NOT NULL DEFAULT 'expense',
  category text NOT NULL,
  hits int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, key)
);
