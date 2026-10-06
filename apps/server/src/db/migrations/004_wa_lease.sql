-- Quem segura a conexão do WhatsApp agora é um "aluguel" com validade renovada a cada 15s.
-- O lock de sessão do Postgres ficava preso quando o container antigo morria sem fechar a conexão,
-- e o worker novo esperava para sempre sem escutar o WhatsApp.
ALTER TABLE wa_sessions ADD COLUMN holder text;
ALTER TABLE wa_sessions ADD COLUMN lease_until timestamptz;
ALTER TABLE wa_sessions ADD COLUMN heartbeat_at timestamptz;
ALTER TABLE wa_sessions ADD COLUMN last_message_at timestamptz;
