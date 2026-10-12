-- Compras vira busca de preço: o assistente compara as lojas e manda o link; a pessoa compra no app da loja.
-- O checkout pelo navegador saiu; as tabelas antigas (purchases, buyer_profiles, store_sessions, store_logins, user_stores)
-- ficam no banco sem uso até o dono decidir apagar.

-- Lista de compras: o que a pessoa quer comprar, com o preço e o link que o assistente achou.
-- O aviso de preço é um acompanhamento (watches) ligado ao item.
CREATE TABLE IF NOT EXISTS shopping_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  store text,
  cents integer CHECK (cents IS NULL OR cents > 0),
  link text,
  image text,
  query text,
  watch_id uuid REFERENCES watches(id) ON DELETE SET NULL,
  bought_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shopping_items_user_idx ON shopping_items (user_id, created_at DESC);
