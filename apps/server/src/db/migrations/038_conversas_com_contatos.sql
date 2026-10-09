-- Conversas que o assistente tem com pessoas em nome de alguém (send_whatsapp, send_to_contact e as respostas),
-- para a tela Recados mostrar cada contato como uma conversa. Particular: só a própria pessoa vê.
-- dir: out = o assistente mandou em nome da pessoa; in = o contato respondeu ou mandou para ela pelo Planejai.
CREATE TABLE IF NOT EXISTS contact_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone text NOT NULL,
  name text,
  dir text NOT NULL CHECK (dir IN ('out', 'in')),
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_messages_user_idx ON contact_messages (user_id, phone, created_at);

-- o que já tinha saído por mensagem avulsa entra como começo da conversa
INSERT INTO contact_messages (user_id, phone, name, dir, text, created_at)
SELECT user_id, phone, name, 'out', text, sent_at FROM direct_messages
 WHERE status = 'sent' AND sent_at IS NOT NULL AND sent_at > now() - interval '30 days';
