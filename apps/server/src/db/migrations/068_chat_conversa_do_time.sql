-- Chat do app: o que o time conversa entre si (o CTO pedindo para a Agenda, a Agenda respondendo) aparece na
-- tela como uma conversinha à parte. Só o começo de cada fala; o motor não lê esta tabela.
alter table app_chat drop constraint if exists app_chat_role_check;
alter table app_chat add constraint app_chat_role_check check (role in ('user', 'assistant', 'team'));
