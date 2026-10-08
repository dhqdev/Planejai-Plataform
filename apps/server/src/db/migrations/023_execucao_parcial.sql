-- Execução que respondeu mas parou no meio (tempo máximo, limite de ações, especialista sem tempo) não é "sucesso":
-- vira 'partial' e o motivo fica em error.
ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_status_check;
ALTER TABLE executions ADD CONSTRAINT executions_status_check CHECK (status IN ('running', 'success', 'partial', 'error'));
