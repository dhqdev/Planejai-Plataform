-- Chat do app (aba Início no celular): a conversa com o time pelo painel, guardada para a pessoa ver de novo.
-- O motor é o mesmo do WhatsApp (conversa com channel = 'app'); aqui fica só o que aparece na tela.
create table if not exists app_chat (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  text text,
  -- mídia: { kind, mimetype, fileName, seconds, gif, ptt }; o arquivo em base64 fica em data
  media jsonb,
  data text,
  external_id text,
  reaction text,
  created_at timestamptz not null default now()
);
create index if not exists app_chat_user_idx on app_chat (user_id, id);
create index if not exists app_chat_ext_idx on app_chat (user_id, external_id) where external_id is not null;

-- "digitando..." / "gravando áudio..." do assistente no app
create table if not exists app_chat_state (
  user_id uuid primary key references users(id) on delete cascade,
  typing_until timestamptz,
  typing_kind text
);
