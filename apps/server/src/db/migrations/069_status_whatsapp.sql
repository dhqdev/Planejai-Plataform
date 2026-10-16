-- Status do WhatsApp do número do assistente (wa-status.ts): rascunhos e posts com o Bolinho ou com post do blog.
-- Nada sai sozinho até o dono ligar a automação no painel (settings 'wa_status').
CREATE TABLE IF NOT EXISTS wa_status_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- imagem (cena do Bolinho gerada) | blog (capa e link de um post do blog)
  kind text NOT NULL CHECK (kind IN ('imagem', 'blog')),
  scene text,
  caption text NOT NULL,
  mimetype text NOT NULL,
  data bytea NOT NULL,
  blog_post_id uuid REFERENCES blog_posts(id) ON DELETE SET NULL,
  -- rascunho | postado | falhou
  status text NOT NULL DEFAULT 'rascunho',
  recipients int,
  error text,
  cost_usd numeric(10, 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz
);
CREATE INDEX IF NOT EXISTS wa_status_posts_created ON wa_status_posts (created_at DESC);
