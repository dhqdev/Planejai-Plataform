-- Marlene entra sozinha na reunião pelo link (meet-bot.ts): o robô do navegador da stack pede para participar,
-- ouve e manda os trechos como o painel manda. mode 'robo' x 'painel'; heartbeat diz se o robô ainda está vivo.
ALTER TABLE meet_sessions ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'painel';
ALTER TABLE meet_sessions ADD COLUMN IF NOT EXISTS meet_url text;
ALTER TABLE meet_sessions ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

-- quem já ligou a Marlene ganha as ferramentas de entrar e sair pelo link
UPDATE client_agents SET tools = array_append(tools, 'meeting_join')
 WHERE origin = 'loja' AND slug = 'reunioes' AND NOT ('meeting_join' = ANY(tools));
UPDATE client_agents SET tools = array_append(tools, 'meeting_leave')
 WHERE origin = 'loja' AND slug = 'reunioes' AND NOT ('meeting_leave' = ANY(tools));
