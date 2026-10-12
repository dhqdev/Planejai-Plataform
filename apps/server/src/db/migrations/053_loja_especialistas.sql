-- Loja de especialistas: agente ligado pela própria pessoa no painel ('loja'). A reunião noturna só mexe nos 'melhoria'.
ALTER TABLE client_agents DROP CONSTRAINT IF EXISTS client_agents_origin_check;
ALTER TABLE client_agents ADD CONSTRAINT client_agents_origin_check CHECK (origin IN ('melhoria', 'pedido', 'loja'));
