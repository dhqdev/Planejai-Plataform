-- Anotações (pedido do David em 2026-11-12): documentos de cada pessoa no estilo do Google Docs, com títulos,
-- tópicos e negrito. A pessoa edita no painel (aba Anotações) e a Zulmira escreve sozinha quando ela pede no
-- WhatsApp ("anota em tópicos..."). O conteúdo é HTML já limpo pelo servidor (notes.ts, lista fechada de tags).
CREATE TABLE IF NOT EXISTS notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  html text NOT NULL DEFAULT '',
  pinned boolean NOT NULL DEFAULT false,
  -- quem mexeu por último: 'pessoa' (painel) ou 'planejai' (agente pelo WhatsApp)
  updated_by text NOT NULL DEFAULT 'pessoa',
  created_by text NOT NULL DEFAULT 'pessoa',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_user_idx ON notes (user_id, updated_at DESC);

-- Versões anteriores: guardadas antes de o Planejai mexer (e antes de restaurar), para a pessoa voltar atrás.
-- Ficam as 20 mais novas de cada anotação.
CREATE TABLE IF NOT EXISTS note_versions (
  id bigserial PRIMARY KEY,
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title text NOT NULL,
  html text NOT NULL,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS note_versions_note_idx ON note_versions (note_id, created_at DESC);

-- painel em tempo real (077): a anotação aberta recebe o que o Planejai escreveu sem recarregar a página
DROP TRIGGER IF EXISTS pj_live ON notes;
CREATE TRIGGER pj_live AFTER INSERT OR UPDATE OR DELETE ON notes FOR EACH ROW EXECUTE FUNCTION pj_live_user();
