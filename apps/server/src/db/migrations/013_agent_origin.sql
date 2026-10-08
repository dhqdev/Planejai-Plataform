-- Agente sob medida: quem criou. 'melhoria' = reunião noturna; 'pedido' = a própria pessoa, na conversa.
ALTER TABLE client_agents ADD COLUMN origin text NOT NULL DEFAULT 'melhoria' CHECK (origin IN ('melhoria', 'pedido'));
