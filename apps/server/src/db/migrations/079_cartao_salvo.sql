-- Cartão guardado no Asaas (token cifrado) para comprar pacote de grãos com um toque; só bandeira e final aparecem.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS saved_card_token text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS saved_card_brand text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS saved_card_last4 text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS saved_card_at timestamptz;
