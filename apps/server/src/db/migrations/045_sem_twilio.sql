-- Ligações passam a sair da central própria (imagem voz: Asterisk + gateway GSM). As credenciais do Twilio saem do banco.
DELETE FROM integrations WHERE id = 'twilio';
