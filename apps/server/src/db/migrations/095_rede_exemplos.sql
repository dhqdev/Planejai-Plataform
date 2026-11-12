-- comentários automáticos das pessoas de exemplo da rede (feed-exemplo.ts): `source` impede repetir
ALTER TABLE feed_comments ADD COLUMN IF NOT EXISTS source text;
CREATE UNIQUE INDEX IF NOT EXISTS feed_comments_source ON feed_comments (source) WHERE source IS NOT NULL;
