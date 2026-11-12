-- Rede social, parte 2 (pedido do David em 2026-11-12): o próprio Planejai tem perfil oficial e posta no feed
-- o que sai no status do WhatsApp e no blog, além de uns posts de partida (feed-oficial.ts).
-- Perfil oficial: selo de verificado na tela; só existe um, criado pelo servidor (nunca pelo cadastro).
ALTER TABLE feed_profiles ADD COLUMN IF NOT EXISTS official boolean NOT NULL DEFAULT false;

-- post em cartão (texto grande sobre uma cor, no jeito dos posts de frase do Instagram): nome da cor ou null
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS card text;
-- cartão de link (post do blog): endereço, título e linha de apoio; a capa vai em feed_media como foto
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS link_url text;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS link_title text;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS link_desc text;
-- de onde veio um post automático (seed:<n>, blog:<id>, wa_status:<id>): impede post repetido
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS source text;
CREATE UNIQUE INDEX IF NOT EXISTS feed_posts_source ON feed_posts (source) WHERE source IS NOT NULL;

ALTER TABLE feed_status ADD COLUMN IF NOT EXISTS source text;
CREATE UNIQUE INDEX IF NOT EXISTS feed_status_source ON feed_status (source) WHERE source IS NOT NULL;
