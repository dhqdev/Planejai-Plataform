-- Cada pessoa tem Finanças e Agenda particulares. Ela pode deixar um contato (alguém do convite) ver uma delas.
CREATE TABLE IF NOT EXISTS shares (
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('finance', 'agenda')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, viewer_id, scope)
);
CREATE INDEX IF NOT EXISTS shares_viewer ON shares (viewer_id);
