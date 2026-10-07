-- Sessão revogável: o token do painel carrega a versão; trocar senha, desativar ou "sair de todos" aumenta.
ALTER TABLE accounts ADD COLUMN session_version integer NOT NULL DEFAULT 1;

-- LGPD: quando a pessoa aceitou os termos e a política de privacidade (cadastro ou SIM no convite).
ALTER TABLE accounts ADD COLUMN terms_accepted_at timestamptz;
ALTER TABLE users ADD COLUMN terms_accepted_at timestamptz;

-- Custo de IA por pessoa por dia: fica guardado mesmo depois que os logs de execução são apagados.
ALTER TABLE usage_daily ADD COLUMN executions integer NOT NULL DEFAULT 0;
ALTER TABLE usage_daily ADD COLUMN tokens_in bigint NOT NULL DEFAULT 0;
ALTER TABLE usage_daily ADD COLUMN tokens_out bigint NOT NULL DEFAULT 0;
ALTER TABLE usage_daily ADD COLUMN cost_usd numeric(12, 6) NOT NULL DEFAULT 0;

INSERT INTO usage_daily (user_id, day, executions, tokens_in, tokens_out, cost_usd)
SELECT user_id, started_at::date, COUNT(*), SUM(tokens_in), SUM(tokens_out), SUM(cost_usd)
  FROM executions WHERE user_id IS NOT NULL GROUP BY 1, 2
ON CONFLICT (user_id, day) DO UPDATE SET executions = EXCLUDED.executions, tokens_in = EXCLUDED.tokens_in,
  tokens_out = EXCLUDED.tokens_out, cost_usd = EXCLUDED.cost_usd;

-- Logs sem conversa: depois de LOG_CONTENT_HOURS o texto sai e ficam só custo, tempo e modelo.
ALTER TABLE executions ADD COLUMN content_purged boolean NOT NULL DEFAULT false;
CREATE INDEX executions_purge_idx ON executions (started_at) WHERE NOT content_purged;
