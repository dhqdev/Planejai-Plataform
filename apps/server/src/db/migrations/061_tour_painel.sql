-- Tour animado do painel no primeiro login: quem já tinha conta não vê (já conhece o painel).
-- Conta nova nasce com NULL e vê o tour uma vez; o painel grava a data ao terminar ou pular.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tour_seen_at timestamptz;
UPDATE accounts SET tour_seen_at = now() WHERE tour_seen_at IS NULL;
