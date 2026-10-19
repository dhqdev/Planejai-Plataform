-- Custo de IA por dia de toda a plataforma (inclui o que não tem pessoa: blog, status, esteira, sistema).
-- As execuções são apagadas depois de EXECUTION_RETENTION_DAYS, então o "no mês" do painel não podia sair delas.
CREATE TABLE IF NOT EXISTS cost_daily (
  day date PRIMARY KEY,
  cost_usd numeric(14, 6) NOT NULL DEFAULT 0,
  tokens_in bigint NOT NULL DEFAULT 0,
  tokens_out bigint NOT NULL DEFAULT 0,
  calls integer NOT NULL DEFAULT 0
);

-- o que ainda existe nas execuções entra de início (o resto do mês só some se já foi apagado)
INSERT INTO cost_daily (day, cost_usd, tokens_in, tokens_out, calls)
SELECT s.started_at::date, SUM(s.cost_usd), SUM(s.tokens_in), SUM(s.tokens_out), COUNT(*) FILTER (WHERE s.model IS NOT NULL)
  FROM execution_steps s GROUP BY 1
ON CONFLICT (day) DO NOTHING;
