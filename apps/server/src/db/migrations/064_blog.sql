-- Blog público (/blog) no estilo de revista: posts escritos pelo time (4 de partida no código, blog-seed.ts) e um novo
-- por semana escrito sozinho pelo worker (blog.ts). Imagens geradas pela rota "Imagens" ficam aqui mesmo (JPEG leve).
CREATE TABLE IF NOT EXISTS blog_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  subtitle text NOT NULL DEFAULT '',
  category text NOT NULL,
  excerpt text NOT NULL DEFAULT '',
  -- markdown simples: ## e ###, parágrafos, listas, tabela com |, > dica e [[imagem]] para a ilustração do meio
  body text NOT NULL,
  cover_prompt text NOT NULL DEFAULT '',
  inline_prompt text,
  reading_minutes int NOT NULL DEFAULT 5,
  -- published, hidden
  status text NOT NULL DEFAULT 'published',
  -- seed (veio no código), auto (escrito pelo worker), manual (pedido no painel)
  source text NOT NULL DEFAULT 'auto',
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS blog_posts_published ON blog_posts (published_at DESC) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS blog_images (
  post_id uuid NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
  -- cover (topo e cartão) ou inline (no meio do texto)
  slot text NOT NULL,
  mimetype text NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, slot)
);

-- tentativas que falharam: o worker desiste depois de 3 e o painel mostra o botão de gerar de novo
CREATE TABLE IF NOT EXISTS blog_image_failures (
  post_id uuid NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
  slot text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, slot)
);
