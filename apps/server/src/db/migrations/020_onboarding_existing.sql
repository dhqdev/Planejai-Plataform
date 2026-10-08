-- Perguntas de boas-vindas do cadastro: quem já usava não vê o questionário ao entrar
-- (pode responder quando quiser pelo Perfil). Só quem chega depois desta versão começa por ele.
UPDATE users SET profile = profile || '{"onboarding": {"skipped": true, "legacy": true}}'::jsonb
 WHERE NOT (profile ? 'onboarding');
