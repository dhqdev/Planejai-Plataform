-- WhatsApp (Baileys): o dono pode parar a conexão pelo painel. Enquanto stopped_at estiver preenchido,
-- o worker não religa sozinho (nem depois de um redeploy) até alguém tocar em Reconectar.
ALTER TABLE wa_sessions ADD COLUMN stopped_at timestamptz;
