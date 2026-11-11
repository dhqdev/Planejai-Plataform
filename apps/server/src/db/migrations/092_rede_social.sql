-- Rede social do Planejai (pedido do David em 2026-11-11): feed no jeito do Instagram com o Twitter e status de 24h.
-- Nada particular entra aqui sozinho: a pessoa só aparece depois de criar o perfil (feed_profiles) e só o que
-- ela mesma publica é visto pelos outros. Tudo sai em cascata quando a pessoa some (LGPD).

CREATE TABLE IF NOT EXISTS feed_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  handle text NOT NULL,
  name text NOT NULL,
  bio text NOT NULL DEFAULT '',
  -- até quando a pessoa já viu a Atividade (curtidas, comentários e seguidores novos)
  activity_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS feed_profiles_handle ON feed_profiles (lower(handle));

CREATE TABLE IF NOT EXISTS feed_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES feed_profiles(user_id) ON DELETE CASCADE,
  body text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_posts_recent ON feed_posts (created_at DESC);
CREATE INDEX IF NOT EXISTS feed_posts_user ON feed_posts (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS feed_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES feed_profiles(user_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('text', 'photo')),
  body text NOT NULL DEFAULT '',
  bg text NOT NULL DEFAULT 'tinta',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX IF NOT EXISTS feed_status_live ON feed_status (expires_at, user_id);

-- fotos dos posts e dos status: no bucket quando há storage (storage_key), senão no banco (data)
CREATE TABLE IF NOT EXISTS feed_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid REFERENCES feed_posts(id) ON DELETE CASCADE,
  status_id uuid REFERENCES feed_status(id) ON DELETE CASCADE,
  pos int NOT NULL DEFAULT 0,
  mimetype text NOT NULL,
  width int NOT NULL DEFAULT 0,
  height int NOT NULL DEFAULT 0,
  size int NOT NULL DEFAULT 0,
  data bytea,
  storage_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (post_id IS NOT NULL OR status_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS feed_media_post ON feed_media (post_id, pos);
CREATE INDEX IF NOT EXISTS feed_media_status ON feed_media (status_id);
DROP TRIGGER IF EXISTS feed_media_storage_trash ON feed_media;
CREATE TRIGGER feed_media_storage_trash AFTER DELETE ON feed_media FOR EACH ROW EXECUTE FUNCTION storage_trash_on_delete();

CREATE TABLE IF NOT EXISTS feed_likes (
  post_id uuid NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES feed_profiles(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS feed_likes_user ON feed_likes (user_id);

CREATE TABLE IF NOT EXISTS feed_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES feed_profiles(user_id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_comments_post ON feed_comments (post_id, created_at);

CREATE TABLE IF NOT EXISTS feed_follows (
  follower_id uuid NOT NULL REFERENCES feed_profiles(user_id) ON DELETE CASCADE,
  followed_id uuid NOT NULL REFERENCES feed_profiles(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id <> followed_id)
);
CREATE INDEX IF NOT EXISTS feed_follows_followed ON feed_follows (followed_id);

CREATE TABLE IF NOT EXISTS feed_blocks (
  blocker_id uuid NOT NULL REFERENCES feed_profiles(user_id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES feed_profiles(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS feed_blocks_blocked ON feed_blocks (blocked_id);

CREATE TABLE IF NOT EXISTS feed_status_views (
  status_id uuid NOT NULL REFERENCES feed_status(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES feed_profiles(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (status_id, user_id)
);

-- denúncias: o dono vê no sininho e apaga o que não devia estar ali
CREATE TABLE IF NOT EXISTS feed_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES feed_profiles(user_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('post', 'comment', 'status', 'profile')),
  target_id uuid NOT NULL,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reporter_id, kind, target_id)
);
