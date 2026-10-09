-- Cobrança por grãos (créditos): cada pessoa tem uma carteira com os grãos do plano (recarregam a cada mês pago)
-- e os grãos extras (boas-vindas, pacotes avulsos; não vencem). O uso de IA desconta primeiro do plano.
CREATE TABLE IF NOT EXISTS wallets (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan_grains integer NOT NULL DEFAULT 0 CHECK (plan_grains >= 0),
  extra_grains integer NOT NULL DEFAULT 0 CHECK (extra_grains >= 0),
  welcome_at timestamptz,
  low_notice_at timestamptz,
  empty_notice_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Extrato: cada entrada e saída de grãos. O uso entra somado por dia (ref = AAAA-MM-DD).
CREATE TABLE IF NOT EXISTS grain_ledger (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta integer NOT NULL,
  reason text NOT NULL,
  ref text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS grain_ledger_ref ON grain_ledger (user_id, reason, ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS grain_ledger_user ON grain_ledger (user_id, created_at DESC);

-- Compras avulsas no Asaas: pacote de grãos ou a diferença de uma troca para um plano maior
CREATE TABLE IF NOT EXISTS grain_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  item_id text NOT NULL,
  grains integer NOT NULL,
  value numeric(12, 2) NOT NULL,
  asaas_payment_id text UNIQUE,
  invoice_url text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
CREATE INDEX IF NOT EXISTS grain_purchases_user ON grain_purchases (user_id, created_at DESC);

-- Assinatura passa a ser de um plano: preço cheio, desconto por indicação, troca agendada e o cartão salvo no Asaas
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS plan_id text,
  ADD COLUMN IF NOT EXISTS next_plan_id text,
  ADD COLUMN IF NOT EXISTS base_value numeric(12, 2),
  ADD COLUMN IF NOT EXISTS discount_percent integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pay_method text,
  ADD COLUMN IF NOT EXISTS card_brand text,
  ADD COLUMN IF NOT EXISTS card_last4 text;
