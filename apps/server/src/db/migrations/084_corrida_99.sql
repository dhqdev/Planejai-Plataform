-- 99 pelo WhatsApp (beta): o mesmo robô da Uber, com sessão e corridas separadas por app
ALTER TABLE uber_sessions ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'uber' CHECK (provider IN ('uber', '99'));
ALTER TABLE uber_sessions DROP CONSTRAINT IF EXISTS uber_sessions_pkey;
ALTER TABLE uber_sessions ADD PRIMARY KEY (user_id, provider);
ALTER TABLE uber_rides ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'uber' CHECK (provider IN ('uber', '99'));
