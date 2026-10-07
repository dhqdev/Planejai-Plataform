-- Reconexão do WhatsApp (Baileys): o painel mostra "reconectando" enquanto o worker religa sozinho
-- (em vez de "desconectado", que pede QR novo), e down_since marca desde quando a conexão está caída
-- para o healthcheck reiniciar o container se a religação não der certo por tempo demais.
ALTER TABLE wa_sessions DROP CONSTRAINT IF EXISTS wa_sessions_status_check;
ALTER TABLE wa_sessions ADD CONSTRAINT wa_sessions_status_check
  CHECK (status IN ('disconnected', 'connecting', 'reconnecting', 'qr', 'pairing', 'connected'));
ALTER TABLE wa_sessions ADD COLUMN down_since timestamptz;
