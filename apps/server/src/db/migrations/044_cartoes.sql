-- Cartões de crédito da pessoa: só apelido, banco/bandeira, final de 4 dígitos, limite, fechamento e vencimento.
-- Nunca guardamos número completo, CVV nem validade.
CREATE TABLE IF NOT EXISTS cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  brand text,
  last4 text CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),
  limit_amount numeric(14, 2) CHECK (limit_amount IS NULL OR limit_amount >= 0),
  closing_day smallint NOT NULL CHECK (closing_day BETWEEN 1 AND 31),
  due_day smallint NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  color text NOT NULL DEFAULT 'preto',
  remind_days_before smallint NOT NULL DEFAULT 3,
  active boolean NOT NULL DEFAULT true,
  last_reminded_on date,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cards_user ON cards (user_id) WHERE active;

-- Compra no cartão: em qual cartão e em qual fatura (AAAA-MM do vencimento) cai cada parcela.
-- purchase_id junta as parcelas da mesma compra; installment/installments = "3 de 10".
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS card_id uuid REFERENCES cards(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS invoice_month text;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS purchase_id uuid;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS installment smallint;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS installments smallint;
CREATE INDEX IF NOT EXISTS transactions_card_idx ON transactions (card_id, invoice_month) WHERE card_id IS NOT NULL;

-- Fatura paga (marcar não lança gasto de novo: as compras já estão nos lançamentos)
CREATE TABLE IF NOT EXISTS card_invoices (
  card_id uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  month text NOT NULL,
  paid_at timestamptz NOT NULL DEFAULT now(),
  paid_amount numeric(14, 2),
  PRIMARY KEY (card_id, month)
);
