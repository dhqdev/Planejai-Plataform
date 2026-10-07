-- Clientes: nome completo, e-mail e quem convidou
ALTER TABLE users ADD COLUMN full_name text;
ALTER TABLE users ADD COLUMN email text;
ALTER TABLE users ADD COLUMN invited_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Convites: só se entra na plataforma por convite. Chegam pelo WhatsApp e a pessoa responde SIM ou NÃO.
CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  inviter_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  inviter_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  name text,
  phone text NOT NULL,
  email text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
  invitee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '14 days'
);
CREATE INDEX invites_phone_idx ON invites (phone) WHERE status = 'pending';
CREATE INDEX invites_inviter_idx ON invites (inviter_user_id);

-- Quem aceitou o convite vira contato dos dois lados e eles podem mandar coisas um pro outro pelo assistente
CREATE TABLE contacts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, contact_id)
);

-- Agentes criados para cada cliente pela melhoria diária (ex.: "Cinema" para quem pergunta muito de filme)
CREATE TABLE client_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  focus text NOT NULL,
  instructions text NOT NULL,
  tools text[] NOT NULL DEFAULT '{}',
  uses integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);

-- Assuntos de cada cliente, acumulados dia a dia (base para criar agentes)
CREATE TABLE user_topics (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic text NOT NULL,
  score real NOT NULL DEFAULT 0,
  days integer NOT NULL DEFAULT 0,
  last_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic)
);

-- Acompanhamentos: o agente fica de olho (preço, novidade) e manda mensagem quando acha algo melhor
CREATE TABLE watches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('price', 'news')),
  query text NOT NULL,
  target numeric(14,2),
  best jsonb,
  seen text[] NOT NULL DEFAULT '{}',
  every_hours integer NOT NULL DEFAULT 6,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  notified integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX watches_due_idx ON watches (next_check_at) WHERE active;

-- Uso diário por pessoa (as mensagens em si não ficam guardadas: já estão no WhatsApp)
CREATE TABLE usage_daily (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,
  messages integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Painel editável: layout de cada conta
ALTER TABLE accounts ADD COLUMN dashboard jsonb;

-- Resumo da conversa a partir da memória curta (Redis): até que horário já foi resumido
ALTER TABLE conversations ADD COLUMN summary_ts bigint NOT NULL DEFAULT 0;
