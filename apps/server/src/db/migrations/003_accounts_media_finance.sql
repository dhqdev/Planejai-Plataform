-- Contas do painel: o dono da stack (ADMIN_EMAIL do .env) é sempre super admin;
-- quem se cadastra vira admin da própria conta (vê só os próprios dados).
CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'admin' CHECK (role IN ('superadmin', 'admin')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('active', 'pending', 'disabled')),
  -- pessoa do WhatsApp ligada a esta conta (pelo número informado no cadastro)
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- Gastos: de onde veio o lançamento e chave para não duplicar o mesmo comprovante
ALTER TABLE transactions ADD COLUMN source text NOT NULL DEFAULT 'conversa';
ALTER TABLE transactions ADD COLUMN merchant text;
ALTER TABLE transactions ADD COLUMN external_ref text;
CREATE UNIQUE INDEX transactions_ref_idx ON transactions (user_id, external_ref) WHERE external_ref IS NOT NULL;

-- Arquivos gerados pelos agentes (gravações do navegador, prints) para ver no dashboard
CREATE TABLE media_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid REFERENCES executions(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  mimetype text NOT NULL,
  file_name text,
  size integer NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_files_created_idx ON media_files (created_at);
CREATE INDEX messages_created_idx ON messages (created_at);
