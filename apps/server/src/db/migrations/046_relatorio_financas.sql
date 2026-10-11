-- Relatório de finanças em PDF enviado todo mês no dia que a pessoa escolheu (Finanças > Relatório PDF).
CREATE TABLE finance_report_schedules (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  day smallint NOT NULL CHECK (day BETWEEN 1 AND 31),
  last_sent_on date,
  created_at timestamptz NOT NULL DEFAULT now()
);
