-- Compras não entra mais na conta da loja (virou busca de preço): o dono pediu para apagar os logins que o robô antigo guardou
-- (cookies das lojas e e-mail/senha do login automático, criptografados). Sem volta.
DROP TABLE IF EXISTS store_logins;
DROP TABLE IF EXISTS store_sessions;
