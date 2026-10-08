-- Regras financeiras (assinatura + contas fixas), vindas dos fluxos antigos do n8n.

-- Avisos do Asaas já tratados: o Asaas reenvia o mesmo evento quando não recebe 200, e cada um só pode virar mensagem uma vez.
CREATE TABLE IF NOT EXISTS asaas_events (
  id text PRIMARY KEY,
  event text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- forma do último pagamento (cartão renova sozinho: não precisa lembrar) e último dia em que lembramos do vencimento
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_billing_type text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS reminded_on date;

-- Indicação: quem convidou ganha desconto na próxima mensalidade quando o convidado paga a primeira vez (uma vez por convidado).
CREATE TABLE IF NOT EXISTS referral_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  percent numeric(5, 2) NOT NULL,
  -- cobrança do Asaas em que o desconto entrou (vazio = ainda esperando a próxima cobrança)
  applied_payment_id text,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referral_credits_pending ON referral_credits (user_id) WHERE applied_payment_id IS NULL;

-- Contas fixas da pessoa (aluguel, internet, parcela, salário): lembrete antes do vencimento e "paguei" lança no mês.
CREATE TABLE IF NOT EXISTS bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'income')),
  description text NOT NULL,
  -- vazio = valor muda todo mês (luz, cartão): pergunta na hora de lançar
  amount numeric(12, 2),
  category text NOT NULL DEFAULT 'Contas',
  due_day int NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  remind_days_before int NOT NULL DEFAULT 1 CHECK (remind_days_before BETWEEN 0 AND 10),
  -- parcelas: quantas faltam (vazio = sem fim); chega a 0 e a conta encerra sozinha
  installments_left int,
  active boolean NOT NULL DEFAULT true,
  last_paid_month text,
  last_reminded_on date,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bills_user ON bills (user_id) WHERE active;
