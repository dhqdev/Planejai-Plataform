-- Compras: lojas que a pessoa cadastrou (fora do catálogo) e o acesso salvo de cada loja (e-mail e senha, criptografados)
CREATE TABLE IF NOT EXISTS user_stores (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  domain text NOT NULL,
  home text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS store_logins (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store text NOT NULL,
  data text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, store)
);
