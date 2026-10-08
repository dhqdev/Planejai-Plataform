-- Assinatura mensal pelo Asaas: uma por pessoa. O CPF/CNPJ e os dados de pagamento ficam só no Asaas.
CREATE TABLE subscriptions (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  asaas_customer_id text NOT NULL,
  asaas_subscription_id text UNIQUE,
  -- trial = assinou e a primeira cobrança ainda não venceu; active = em dia; overdue = pagamento pendente; canceled = cancelada
  status text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial', 'active', 'overdue', 'canceled')),
  value numeric(12, 2) NOT NULL,
  next_due_date date,
  -- até quando o último pagamento cobre (vale mesmo depois de cancelar)
  paid_until date,
  last_payment_at timestamptz,
  -- link da cobrança em aberto na página do Asaas (Pix, cartão ou boleto)
  invoice_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- pessoa liberada sem cobrança pelo dono (família, parceiro, teste)
ALTER TABLE users ADD COLUMN billing_exempt boolean NOT NULL DEFAULT false;
