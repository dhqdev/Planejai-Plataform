-- Prompts dos agentes editados pelo dono no Mapa do time (tela cheia). Sem linha = texto padrão do código.
-- agent: cto, id de especialista, "_time" (regras comuns dos especialistas) ou agente de bastidor (visao, redator_pdf...).
-- base_hash: resumo do texto padrão na hora da edição, para avisar quando o padrão do código mudar depois.
create table if not exists agent_prompts (
  agent text primary key,
  role text,
  instructions text,
  base_hash text,
  updated_at timestamptz not null default now()
);
