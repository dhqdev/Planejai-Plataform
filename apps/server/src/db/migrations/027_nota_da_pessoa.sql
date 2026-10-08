-- O que a própria pessoa pediu para um especialista fixo fica separado do que a reunião noturna aprende:
-- a reunião reescreve note, nunca user_note.
ALTER TABLE agent_notes ADD COLUMN IF NOT EXISTS user_note text;
ALTER TABLE agent_notes ALTER COLUMN note DROP NOT NULL;
