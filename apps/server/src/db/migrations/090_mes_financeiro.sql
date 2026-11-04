-- Dia em que o mês financeiro da pessoa começa (pedido do David em 2026-11-04: "se recebo todo dia 5, meu mês
-- começa no dia 5"). 1 = mês do calendário. Até 28 para todo mês ter esse dia.
ALTER TABLE users ADD COLUMN finance_month_start smallint NOT NULL DEFAULT 1
  CHECK (finance_month_start BETWEEN 1 AND 28);
