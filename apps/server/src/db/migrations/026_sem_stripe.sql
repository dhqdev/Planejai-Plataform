-- Stripe saiu da plataforma: apaga a chave guardada (o link de pagamento é só pelo Mercado Pago).
DELETE FROM integrations WHERE id = 'stripe';
DELETE FROM user_integrations WHERE integration_id = 'stripe';
