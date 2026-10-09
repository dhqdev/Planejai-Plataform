-- Compras pelo assistente: o agente vai até o checkout da loja e a compra sai de um de três jeitos
-- (Pix direto da pessoa, cartão cobrado compra a compra pelo Asaas, ou saldo carregado por Pix). Tudo em centavos.

-- Dados de compra da pessoa: CPF, nascimento e endereço ficam criptografados (data); aqui só o que aparece na tela.
CREATE TABLE IF NOT EXISTS buyer_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data text,
  cpf_end text,
  city text,
  terms_version text,
  terms_accepted_at timestamptz,
  -- cartão salvo no Asaas: só o token (criptografado), a bandeira e o final
  card_token text,
  card_brand text,
  card_last4 text,
  -- IP de quem aceitou os termos / cadastrou o cartão (o Asaas pede o IP do titular ao cobrar pelo token)
  remote_ip text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Conta da pessoa numa loja (Mercado Livre, Shopee...): os cookies do login que ela fez pelo painel, criptografados
CREATE TABLE IF NOT EXISTS store_sessions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store text NOT NULL,
  cookies text NOT NULL,
  account_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, store)
);

CREATE TABLE IF NOT EXISTS purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store text NOT NULL,
  title text NOT NULL,
  url text,
  method text NOT NULL CHECK (method IN ('pix', 'card', 'wallet')),
  -- total da loja (produto + frete), lido do Pix dela; a taxa é a nossa
  store_cents integer NOT NULL CHECK (store_cents > 0),
  fee_cents integer NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  total_cents integer NOT NULL CHECK (total_cents > 0),
  store_pix text NOT NULL,
  store_receiver text,
  pix_expires_at timestamptz,
  -- awaiting_confirm > (pix) awaiting_person | (cartão) charging > charged | (saldo) charged
  --   > paying_store > paid > delivered;  falhas: failed, refunded, canceled
  status text NOT NULL DEFAULT 'awaiting_confirm',
  asaas_payment_id text UNIQUE,
  invoice_url text,
  pix_tx_id text UNIQUE,
  order_ref text,
  tracking text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
CREATE INDEX IF NOT EXISTS purchases_user ON purchases (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS purchases_open ON purchases (status) WHERE status IN ('charging', 'charged', 'paying_store');

-- Saldo para compras (separado dos grãos): disponível e reservado, em centavos
CREATE TABLE IF NOT EXISTS shop_wallets (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_cents integer NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  held_cents integer NOT NULL DEFAULT 0 CHECK (held_cents >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Extrato do saldo: cada movimento uma vez por (tipo, ref)
CREATE TABLE IF NOT EXISTS shop_ledger (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('recarga', 'reserva', 'compra', 'devolucao', 'ajuste')),
  delta_cents integer NOT NULL,
  ref text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS shop_ledger_user ON shop_ledger (user_id, created_at DESC);

-- Recargas do saldo (só Pix, pela página do Asaas)
CREATE TABLE IF NOT EXISTS shop_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value_cents integer NOT NULL CHECK (value_cents > 0),
  asaas_payment_id text UNIQUE,
  invoice_url text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
