-- Destaques do perfil (pedido do David em 2026-11-13, "como uma rede social mesmo"): um status marcado como destaque
-- não some depois de 24 horas; fica na fileira de bolinhas do perfil até a pessoa tirar ou apagar.
ALTER TABLE feed_status ADD COLUMN IF NOT EXISTS highlighted_at timestamptz;
CREATE INDEX IF NOT EXISTS feed_status_highlights ON feed_status (user_id, highlighted_at) WHERE highlighted_at IS NOT NULL;
