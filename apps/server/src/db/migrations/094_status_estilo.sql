-- Status de texto com estilo (pedido do David em 2026-11-12): fonte e alinhamento escolhidos na hora de criar.
-- Valores aceitos em feed.ts (STATUS_FONTS, STATUS_ALIGNS); o resto cai no padrão.
ALTER TABLE feed_status ADD COLUMN IF NOT EXISTS font text NOT NULL DEFAULT 'classica';
ALTER TABLE feed_status ADD COLUMN IF NOT EXISTS align text NOT NULL DEFAULT 'center';
