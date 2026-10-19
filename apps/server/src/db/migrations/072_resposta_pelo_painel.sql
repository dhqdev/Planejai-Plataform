-- Recados: a própria pessoa responde pelo painel (2026-10-19). Marca o que ela escreveu, para a tela mostrar
-- como dela e o agente do recado saber que não foi ele.
ALTER TABLE contact_messages ADD COLUMN by_person boolean NOT NULL DEFAULT false;
ALTER TABLE direct_messages ADD COLUMN by_person boolean NOT NULL DEFAULT false;
