CREATE TABLE impersonations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id text NOT NULL,
  target_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX impersonations_created_idx ON impersonations (created_at DESC);
