-- Agenda de contatos da pessoa (importada do celular ou salva pelo assistente), para mandar mensagem pelo nome.
-- Particular: só a própria pessoa vê. name_key é o nome sem acento e em minúsculas, para a busca.
CREATE TABLE IF NOT EXISTS phonebook (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  name_key text NOT NULL,
  phone text NOT NULL,
  label text,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, phone)
);
CREATE INDEX IF NOT EXISTS phonebook_user_name ON phonebook (user_id, name_key);
