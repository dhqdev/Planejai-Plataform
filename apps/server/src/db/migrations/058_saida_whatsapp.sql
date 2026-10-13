-- Quem não usa o Planejai e respondeu SAIR (outreach.ts): não recebe mais mensagem avulsa, recado nem convite.
CREATE TABLE IF NOT EXISTS wa_optouts (
  phone text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
