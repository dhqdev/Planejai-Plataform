-- Chat do app: cartões (calendário da agenda, mini painel de dinheiro) que o servidor monta depois da resposta,
-- sem pedir nada ao modelo. A tela só desenha o que está aqui.
alter table app_chat add column if not exists cards jsonb;
