-- Painel em tempo real (2026-10-19): toda mudança nas tabelas que aparecem no painel avisa a API por
-- pg_notify('pj_live', '<tabela>:<user_id>'), venha do worker, do n8n ou da própria API. A API repassa só o
-- nome da tabela para quem pode ver (live.ts) e a tela recarrega. Sem dado nenhum no aviso.
-- Avisos iguais na mesma transação o Postgres junta sozinho (importação em lote vira um aviso só).

CREATE OR REPLACE FUNCTION pj_live_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('pj_live', TG_TABLE_NAME || ':' || COALESCE(OLD.user_id::text, ''));
  ELSE
    PERFORM pg_notify('pj_live', TG_TABLE_NAME || ':' || COALESCE(NEW.user_id::text, ''));
  END IF;
  RETURN NULL;
END $$;

-- tabelas sem pessoa (telas só do dono): o aviso vai só para o super admin
CREATE OR REPLACE FUNCTION pj_live_any() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('pj_live', TG_TABLE_NAME || ':');
  RETURN NULL;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['reminders', 'transactions', 'cards', 'bills', 'budgets', 'finance_goals', 'finance_categories',
    'watches', 'errands', 'contact_messages', 'notifications', 'documents', 'memories', 'executions', 'app_chat',
    'app_chat_state', 'phonebook', 'contacts', 'meet_sessions', 'improve_meetings', 'alarms', 'agenda_tags', 'wallets'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS pj_live ON %I', t);
    EXECUTE format('CREATE TRIGGER pj_live AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION pj_live_user()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['execution_steps', 'dev_tickets', 'dev_ticket_steps', 'blog_posts'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS pj_live ON %I', t);
    EXECUTE format('CREATE TRIGGER pj_live AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION pj_live_any()', t);
  END LOOP;
END $$;

-- WhatsApp: o batimento grava a cada poucos segundos; só avisa quando muda o que a tela mostra
DROP TRIGGER IF EXISTS pj_live ON wa_sessions;
CREATE TRIGGER pj_live AFTER UPDATE ON wa_sessions FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.qr IS DISTINCT FROM NEW.qr OR OLD.pairing_code IS DISTINCT FROM NEW.pairing_code
        OR OLD.phone IS DISTINCT FROM NEW.phone OR OLD.last_error IS DISTINCT FROM NEW.last_error)
  EXECUTE FUNCTION pj_live_any();
