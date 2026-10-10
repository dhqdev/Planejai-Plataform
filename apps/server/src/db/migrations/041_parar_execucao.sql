-- Botão "Parar" em Execuções (e "para" no WhatsApp): o painel marca o pedido e o worker que roda a execução
-- confere a cada 2 s, cancela o que estiver em andamento e fecha como parcial.
ALTER TABLE executions ADD COLUMN IF NOT EXISTS stop_requested_at timestamptz;
