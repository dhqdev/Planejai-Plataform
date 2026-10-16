-- Esteira: nível do chamado (simples/medio/complexo decide etapas, modelos e limites; level_auto = a Lia escolhe),
-- o que a Lia viu nas imagens (texto que o time todo lê, barato) e o token da espera do CI (um poller por chamado).
ALTER TABLE dev_tickets ADD COLUMN IF NOT EXISTS level text;
ALTER TABLE dev_tickets ADD COLUMN IF NOT EXISTS level_auto boolean NOT NULL DEFAULT true;
ALTER TABLE dev_tickets ADD COLUMN IF NOT EXISTS image_notes text;
ALTER TABLE dev_tickets ADD COLUMN IF NOT EXISTS poll_token text;

-- Prints e fotos anexados ao chamado (só png/jpeg/webp/gif, até 4 por chamado).
CREATE TABLE IF NOT EXISTS dev_ticket_images (
  id serial PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES dev_tickets(id) ON DELETE CASCADE,
  mime text NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dev_ticket_images_ticket ON dev_ticket_images (ticket_id);
