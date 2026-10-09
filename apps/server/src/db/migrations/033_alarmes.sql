-- Alarme: toca no celular como uma ligação (Web Push do PWA) e, se o dono ligou o Twilio, liga de verdade.
CREATE TABLE alarms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  label text NOT NULL,
  ring_at timestamptz NOT NULL,
  -- scheduled: esperando; rang: tocou (pode ir para soneca); stopped: a pessoa parou; cancelled: cancelado antes
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'rang', 'stopped', 'cancelled')),
  job_id text,
  snoozes integer NOT NULL DEFAULT 0,
  fired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alarms_user_status_idx ON alarms (user_id, status, ring_at);

-- Aparelhos que aceitaram notificação (Web Push); some quando o serviço de push responde 404/410
CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- Ligações feitas pelo alarme (limite por pessoa por dia, para não virar custo sem teto)
CREATE TABLE alarm_calls (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alarm_id uuid REFERENCES alarms(id) ON DELETE SET NULL,
  sid text,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alarm_calls_user_idx ON alarm_calls (user_id, created_at);
