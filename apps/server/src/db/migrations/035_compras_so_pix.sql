-- Compras ficam só no Pix direto (a pessoa paga o Pix da loja do banco dela): sai o cartão e o saldo.
DROP TABLE IF EXISTS shop_topups;
DROP TABLE IF EXISTS shop_ledger;
DROP TABLE IF EXISTS shop_wallets;

-- sem cartão nem CPF: o perfil de compra guarda só o endereço de entrega (criptografado) e o aceite dos termos.
-- O que foi salvo antes podia ter CPF e nascimento: apaga (a pessoa preenche o endereço de novo).
UPDATE buyer_profiles SET data = NULL WHERE data IS NOT NULL;
ALTER TABLE buyer_profiles
  DROP COLUMN IF EXISTS cpf_end,
  DROP COLUMN IF EXISTS card_token,
  DROP COLUMN IF EXISTS card_brand,
  DROP COLUMN IF EXISTS card_last4;

ALTER TABLE purchases
  DROP COLUMN IF EXISTS asaas_payment_id,
  DROP COLUMN IF EXISTS invoice_url,
  DROP COLUMN IF EXISTS pix_tx_id,
  DROP COLUMN IF EXISTS pix_expires_at;
DROP INDEX IF EXISTS purchases_open;
UPDATE purchases SET status = 'canceled' WHERE status NOT IN ('awaiting_confirm', 'awaiting_person', 'paid', 'delivered', 'canceled');
