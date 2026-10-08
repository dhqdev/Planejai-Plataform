# Planejai

Assistente pessoal no WhatsApp com um time de agentes (CTO + especialistas), painel React e uma imagem só (API + worker + dashboard). Detalhes por assunto na skill `.claude/skills/planejai/` (comece pelo `SKILL.md`: mapa, onde procurar cada coisa e qual arquivo ler). Várias sessões no main ao mesmo tempo: `paralelo.md`. Qual modelo/subagente usar: `modelos.md`.

## Como trabalhar aqui

- Push direto na `main`, sem PR (pedido do dono). Cada push com código testa, publica a imagem e atualiza produção.
- Antes do push: `git pull --rebase origin main`, depois `npm run typecheck && npm run lint && npm test`. Os e2e precisam de `TEST_DATABASE_URL` (banco descartável) e `REDIS_URL`; `CHROME_PATH` liga os testes de navegador.
- Mais de uma sessão do Claude pode estar mexendo no repositório ao mesmo tempo: commits pequenos e um assunto por commit. O hook `.claude/hooks/inicio.mjs` mostra no início o que já foi publicado; push recusado = `git pull --rebase origin main` de novo, nunca `--force`.
- Textos para o usuário final em português do Brasil, tom natural de WhatsApp. Mensagens de commit também em português.
- Mudou comportamento descrito na skill `planejai`? Atualize o arquivo dela no mesmo commit.

## Regras que não podem quebrar

- **Time que conversa, não pipeline**; **pouco token**; **dinheiro exato** (centavos, `calculate`, BRL formatado pelas ferramentas).
- Ação sensível (dinheiro, mensagem para terceiro, apagar) só sai com o "sim" da pessoa conferido pelo servidor: `await requireConfirmation(args, resumo, ctx)`. Nunca confie num campo que o modelo preenche.
- Nunca edite uma migração já aplicada: crie `db/migrations/0NN_descricao.sql`.
- Toda URL vinda de usuário, modelo ou página passa por `net.ts` (`safeFetch`/`checkedUrl`). Nada de `fetch(url)` cru.
- Segredos só por variável de ambiente ou pela tela de Integrações (criptografados). Nada de chave no código. Env nova entra em `config.ts` e `.env.example`.
- Integração da stack é do dono: entra em `OWNER_INTEGRATIONS` (`runner.ts`) ou leva `ownerOnly: true`. Conta pessoal (Google, Notion...) fica em `PERSONAL_INTEGRATIONS` e cada cliente usa só a dele (`asPerson`).
- Toda chamada de LLM e de ferramenta passa pelo `Tracer` (aparece em Execuções).
- Imagem de terceiros sempre com versão fixa; nada de dependência nativa no servidor sem ajustar o Dockerfile.
