---
name: planejai
description: Como trabalhar na plataforma Planejai (assistente de IA no WhatsApp com time de agentes CTO + especialistas, OpenRouter, dashboard estilo n8n e deploy no Portainer). Use ao adicionar ferramentas, integrações, especialistas, trocar modelos, mexer no dashboard, rodar/testar localmente ou publicar.
---

# Planejai: guia do projeto

Assistente pessoal no WhatsApp no estilo do Instinct: uma conversa só, com um **time de agentes**.
O **CTO** conversa com a pessoa, reage às mensagens e lidera o time; os especialistas conversam entre si e o CTO revisa antes de responder.
Tudo roda em uma imagem (API + worker + dashboard) com Postgres próprio.

## Mapa do código

```
apps/server/src/
  index.ts                 entrada; ROLE=all|api|worker
  config.ts                variáveis de ambiente (zod) — toda env nova entra aqui e no .env.example
  ingest.ts                webhook -> usuário/conversa/mensagem -> fila (debounce por conversa)
  channels/                baileys.ts (padrão), evolution.ts, cloud.ts (Meta), PlaygroundChannel; wa-message.ts parseia WAMessage
  whatsapp/                session.ts (conexão Baileys: QR, pareamento, reconexão, advisory lock, LISTEN wa_command)
                           auth-state.ts (credenciais/chaves Signal na tabela wa_auth)
  agent/
    orchestrator.ts        processConversation: mídia (áudio/foto), histórico, memórias, CTO, entrega em balões
    runner.ts              loop de tool-calling (tools em paralelo) + trace de cada passo
    collab.ts              TeamRoom: conversa contínua CTO<->especialista (ask_*), consulta entre colegas
                           (consult_*, profundidade máx. 3, sem ciclos) e quadro do time (share_with_team)
    team.ts                SPECIALISTS e CTO_TOOLS — o "organograma" do time
    prompts.ts             prompts do CTO e dos especialistas (pt-BR, estilo WhatsApp)
    trace.ts               executions / execution_steps (logs do dashboard)
    tools/*.ts             ferramentas por domínio (core, research, agenda, finance, communication, productivity)
  llm/openrouter.ts        chat completions com fallback de modelos e custo real (usage.cost)
  llm/router.ts            ROUTE_DEFAULTS: modelo por agente/tarefa; sobrescrito pela tabela model_routes
  integrations/registry.ts INTEGRATIONS: conectores, campos, teste; credenciais AES-256-GCM no banco
  reminders.ts             lembretes (pg-boss + cron-parser), o CTO escreve a mensagem na hora
  api/routes/              webhooks.ts e dashboard.ts (REST do painel)
  db/migrations/*.sql      migrações numeradas, aplicadas no boot
apps/dashboard/src/        React + Vite; pages/* (Execuções com canvas estilo n8n, Time de agentes, Integrações...)
deploy/portainer-stack.yml stack de produção (app, worker, db, browserless)
```

## Receitas

### Adicionar uma ferramenta
1. Crie com `defineTool` no arquivo do domínio em `agent/tools/` (JSON Schema em `parameters`, use `obj()`).
2. Se depende de conector, ponha `integration: "<id>"`: a tool some do agente enquanto não estiver conectada.
3. Ação com dinheiro ou que fala com terceiros: inclua `...CONFIRM_PARAM` e chame `requireConfirmation(args, resumo)` no início.
4. Registre a tool no especialista certo em `agent/team.ts` (ou em `CTO_TOOLS` se for núcleo da conversa).
5. Imagens para enviar: `ctx.outbox.addMedia(...)` e devolva o `media_id`; o CTO posiciona com `[[media:ID]]`.
6. Se a tool chama um LLM, devolva `_usage` (o `ChatResult`) para o custo entrar no log.

### Adicionar uma integração (conector)
1. Adicione em `INTEGRATIONS` (`integrations/registry.ts`): `id`, `fields`, `category`, `icon`, `test()`.
2. Leia credenciais nas tools com `getCredentials("<id>")`. Nunca logue credenciais.
3. Ícone novo: mapa `ICONS` em `apps/dashboard/src/components.tsx`.

### Adicionar um especialista
1. Novo item em `SPECIALISTS` (`team.ts`) com `role` claro (é o que o CTO lê para decidir delegar).
2. Nova rota `agent:<id>` em `ROUTE_DEFAULTS` (`llm/router.ts`) com o modelo mais barato que dá conta.
3. Rótulo em `AGENT_LABEL` (`apps/dashboard/src/components.tsx`).
O CTO ganha automaticamente `ask_<id>` e os outros especialistas ganham `consult_<id>`.

### WhatsApp (Baileys)
- A conexão vive no processo `worker` (ou `all`) e só um processo segura a sessão (`pg_try_advisory_lock`). O worker deve ter 1 réplica.
- A API manda comandos (`connect`, `logout`, `restart`) por `pg_notify('wa_command')`; o status/QR fica em `wa_sessions`, que a tela WhatsApp lê a cada 2s.
- Só reconecta sozinho se a sessão já foi pareada; QR novo só quando alguém pede no dashboard.
- Áudio e foto são baixados na chegada (`downloadMediaMessage`) e o base64 sai do banco depois de transcrito/descrito.
- Não copie código do tekvosoft (AGPL); a implementação aqui é própria, usando só a API pública do Baileys.

### Trocar modelos
Padrões em `ROUTE_DEFAULTS` com o porquê de cada escolha; em produção troque pela tela **Modelos** (grava em `model_routes`, sem redeploy). Critério: entrada barata para quem lê muito histórico (CTO, Pesquisador), saída barata para quem escreve muito, modelo omni para áudio, e sempre `fallbacks`. Confira IDs e preços no catálogo ao vivo (`GET /api/models/catalog`).

### Banco
Nova migração = novo arquivo `db/migrations/00N_descricao.sql` (nunca edite uma já aplicada). Roda sozinha no boot.

## Rodar e testar

```bash
npm ci
cp .env.example .env            # preencha APP_SECRET, ADMIN_PASSWORD, OPENROUTER_API_KEY, DATABASE_URL
docker compose up db -d         # ou um Postgres local
npm run dev                     # API + worker em :3000 (migra no boot)
npm run dev:dashboard           # dashboard em :5173 com proxy para :3000
npm run typecheck && npm test   # e2e do time roda se TEST_DATABASE_URL apontar para um banco descartável
npm run build                   # dashboard vai para apps/server/public
```
Teste conversas sem WhatsApp pela tela **Playground**; cada resposta linka para a execução com todos os passos.

## Publicar
- Push na `main` dispara `.github/workflows/docker.yml`: imagem `ghcr.io/dhqdev/planejai-plataform` para amd64, arm64 e arm/v7, e redeploy no Portainer se o secret `PORTAINER_WEBHOOK_URL` existir.
- Stack: `deploy/portainer-stack.yml` (compose comum) ou `deploy/swarm-traefik-stack.yml` (Swarm + Traefik em network_public, domínio autoplanejai.tekvosoft.com).
- O Dockerfile não executa nada na arquitetura alvo (deps são JS puro). Não adicione dependência nativa no servidor sem ajustar isso.

## Regras do projeto
- Segredos só por variável de ambiente ou pela tela de Integrações (criptografados). Nada de chave no código.
- Textos para o usuário final em português do Brasil, tom natural de WhatsApp, sem templates fixos.
- Toda chamada de LLM e de tool passa pelo `Tracer` para aparecer em Execuções.
