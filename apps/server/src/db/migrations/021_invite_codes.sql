-- Convite por código: o painel gera um link/código que vale 24h e serve uma vez só; o telefone vem no cadastro.
ALTER TABLE invites ALTER COLUMN phone DROP NOT NULL;
