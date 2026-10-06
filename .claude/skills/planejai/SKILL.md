---
name: planejai
description: Como trabalhar na plataforma Planejai (assistente de IA no WhatsApp com time de agentes CTO + especialistas, OpenRouter, Baileys, Redis de memória curta, painéis super admin/admin estilo n8n e deploy no Portainer/Swarm). Use ao adicionar ferramentas, integrações, especialistas, trocar modelos, mexer no dashboard, permissões, rodar/testar localmente ou publicar.
---

# Planejai: guia do projeto

Assistente pessoal no WhatsApp no estilo do Instinct: uma conversa só, com um **time de agentes**.
O **CTO** conversa com a pessoa, reage às mensagens e lidera o time; os especialistas conversam entre si e o CTO revisa antes de responder.
Tudo roda em uma imagem (API + worker + dashboard) com Postgres e Redis próprios da stack.

Princípios que não podem quebrar:
- **Time que conversa, não pipeline**: o CTO tem uma conversa contínua com cada especialista (`ask_*`), especialistas consultam colegas (`consult_*`) e escrevem no quadro do time; o CTO revisa e devolve antes de responder.
- **Pouco token**: o simples o CTO resolve com atalhos (gasto, conta, lembrete, memória); mídia é interpretada uma vez e guardada; documentos são lidos localmente; contexto vem do Redis já interpretado; saída limitada por `maxTokens`.
- **Dinheiro exato**: nunca conta de cabeça (`calculate`), valores em centavos (`parseAmount`, `splitInstallments`), totais formatados em BRL pelas ferramentas.

## Mapa do código

```
apps/server/src/
  index.ts                 entrada; ROLE=all|api|worker
  config.ts                variáveis de ambiente (zod) — toda env nova entra aqui e no .env.example
  ingest.ts                webhook -> usuário/conversa/mensagem -> fila (debounce por conversa)
  accounts.ts              contas do painel: dono (.env) = super admin; cadastro = admin (scopeUserId limita os dados)
  shortmem.ts              memória curta no Redis (pj:conv:<id>:msgs, TTL = MESSAGE_RETENTION_HOURS); cai pro Postgres se o Redis sumir
  maintenance.ts           de hora em hora: resume e apaga mensagens > 24h, logs e gravações antigas
  channels/                baileys.ts (padrão), evolution.ts, cloud.ts (Meta), PlaygroundChannel; wa-message.ts parseia WAMessage
  whatsapp/                session.ts (conexão Baileys: QR, pareamento, reconexão, advisory lock, LISTEN wa_command)
                           auth-state.ts (credenciais/chaves Signal na tabela wa_auth)
  agent/
    orchestrator.ts        processConversation: mídia, contexto (Redis), memórias, CTO, entrega em balões; resumo/compactação
    media.ts               interpreta mídia 1 vez: áudio->texto, foto->descrição (linha FINANCEIRO: p/ comprovantes),
                           documento->texto local (PDF unpdf, DOCX mammoth, XLSX, CSV/TXT/HTML; OCR só p/ PDF escaneado),
                           vídeo->quadros+fala (ffmpeg)
    browser.ts             "computador" dos agentes: puppeteer no browserless (ou CHROME_PATH), snapshot em texto com
                           elementos numerados (barato), ações click/type/press/scroll e gravação em MP4 (screencast + ffmpeg)
    runner.ts              loop de tool-calling (tools em paralelo) + trace de cada passo
    collab.ts              TeamRoom: conversa contínua CTO<->especialista (ask_*), consulta entre colegas
                           (consult_*, profundidade máx. 3, sem ciclos) e quadro do time (share_with_team)
    team.ts                SPECIALISTS e CTO_TOOLS — o "organograma" do time
    prompts.ts             prompts do CTO e dos especialistas (pt-BR, estilo WhatsApp)
    trace.ts               executions / execution_steps (logs do dashboard)
    tools/*.ts             ferramentas por domínio (core, research+browser_*, agenda, finance+calculate, communication, productivity)
  llm/openrouter.ts        chat completions com fallback de modelos e custo real (usage.cost)
  llm/router.ts            ROUTE_DEFAULTS: modelo por agente/tarefa; sobrescrito pela tabela model_routes
  integrations/registry.ts INTEGRATIONS: conectores, campos, teste; credenciais AES-256-GCM no banco
  reminders.ts             lembretes (pg-boss + cron-parser), o CTO escreve a mensagem na hora
  api/server.ts            login (dono ou conta), cadastro, requireAuth/requireSuper
  api/routes/              webhooks.ts e dashboard.ts (REST do painel: bloco com escopo + bloco só super admin)
  db/migrations/*.sql      migrações numeradas, aplicadas no boot
apps/dashboard/src/        React + Vite; App.tsx monta o menu por papel (SUPER_NAV / ADMIN_NAV); pages/* (Execuções com canvas
                           estilo n8n, Finanças, Contas, Início do admin, Login/Cadastro...)
deploy/portainer-stack.yml stack compose (app, worker, db, redis, browserless)
deploy/swarm-traefik-stack.yml  Swarm + Traefik (network_public), domínio autoplanejai.tekvosoft.com
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

### Painéis e permissões
- Dono da stack = `ADMIN_EMAIL`/`ADMIN_PASSWORD` do .env, sempre super admin (id "owner", não fica na tabela).
- Cadastro público (`/api/auth/register`) cria conta `admin` ligada à pessoa do WhatsApp pelo número. Modo em Configurações (`signupMode`): `approval` (padrão), `open` ou `closed`. Aprovar a conta libera o número no WhatsApp; desativar bloqueia.
- Rota nova no `dashboard.ts`: se mostra dados de pessoas, vai no bloco com escopo e filtra com `scopeUserId(req.account)` (null = tudo); se é configuração/custo/sistema, vai no bloco `requireSuper`.
- Página nova no dashboard: rota em `App.tsx` dentro do ramo certo (`isSuper` ou admin) e item no menu correspondente. O teste `features.e2e.test.ts` confere que admin leva 403 nas rotas de super admin; acrescente as novas lá.

### Memória curta, retenção e mídia
- Contexto do CTO = últimas `HISTORY_LIMIT` entradas do Redis (texto já interpretado) + resumo da conversa + memórias. Não volte a mandar mídia crua ou documento inteiro para o LLM: documento entra com prévia de 2.500 caracteres e o resto via `read_document`.
- Mensagens brutas vivem `MESSAGE_RETENTION_HOURS` (24h). `purgeOld` resume antes de apagar; gastos, memórias e lembretes nunca são apagados por ela.
- Gravações e prints ficam em `media_files` (servidos por `/api/media/:id`) por `EXECUTION_RETENTION_DAYS`.

### Gastos automáticos
- Foto/documento de comprovante: a visão escreve `FINANCEIRO: tipo=...; valor_total=...; data=...; estabelecimento=...`; o CTO chama `add_transaction` direto com `message_id` (vira `external_ref`, então reprocessar não duplica).
- Parcelado: `installments` com o valor TOTAL; `splitInstallments` distribui os centavos.
- Respostas das tools financeiras já vêm formatadas (`brl`) para o modelo não errar conta.

### Navegador (pesquisa gravada)
- Ferramentas do Pesquisador: `browser_open` (record/send_recording), `browser_action`, `browser_screenshot`, `browser_close`. A sessão fica em `ctx.room.browser`; o orquestrador fecha o que ficou aberto e manda a gravação se ela foi pedida.
- Precisa de ffmpeg (já na imagem) e do browserless da stack (`TIMEOUT` 300000). Em dev: `CHROME_PATH=/caminho/do/chrome`.

### Trocar modelos
Padrões em `ROUTE_DEFAULTS` com o porquê de cada escolha e `maxTokens` por rota; em produção troque pela tela **Modelos** (grava em `model_routes`, sem redeploy). Critério: entrada barata para quem lê muito histórico (CTO, Pesquisador), saída barata para quem escreve muito, modelo omni para áudio, e sempre `fallbacks`. Confira IDs e preços no catálogo ao vivo (`GET /api/models/catalog`).

### Banco
Nova migração = novo arquivo `db/migrations/00N_descricao.sql` (nunca edite uma já aplicada). Roda sozinha no boot.

## Rodar e testar

```bash
npm ci
cp .env.example .env            # preencha APP_SECRET, ADMIN_PASSWORD, OPENROUTER_API_KEY, DATABASE_URL
docker compose up db redis -d   # ou Postgres/Redis locais
npm run dev                     # API + worker em :3000 (migra no boot)
npm run dev:dashboard           # dashboard em :5173 com proxy para :3000
npm run typecheck && npm test   # e2e rodam com TEST_DATABASE_URL (banco descartável); REDIS_URL e CHROME_PATH ligam os testes de Redis e navegador
npm run build                   # dashboard vai para apps/server/public
```
Teste conversas sem WhatsApp pela tela **Playground**; cada resposta linka para a execução com todos os passos.

## Publicar
- Push na `main` dispara `.github/workflows/docker.yml`: imagem `ghcr.io/dhqdev/planejai-plataform` para amd64, arm64 e arm/v7, e redeploy no Portainer se o secret `PORTAINER_WEBHOOK_URL` existir.
- Stack: `deploy/portainer-stack.yml` (compose comum) ou `deploy/swarm-traefik-stack.yml` (Swarm + Traefik em network_public, domínio autoplanejai.tekvosoft.com). Postgres e Redis são da própria stack; nunca aponte para os que já existem no servidor.
- O Dockerfile só roda `apk add ffmpeg` na arquitetura alvo; o resto das deps é JS puro. Não adicione dependência nativa no servidor sem ajustar isso.

## Regras do projeto
- Segredos só por variável de ambiente ou pela tela de Integrações (criptografados). Nada de chave no código.
- Textos para o usuário final em português do Brasil, tom natural de WhatsApp, sem templates fixos.
- Toda chamada de LLM e de tool passa pelo `Tracer` para aparecer em Execuções.
- Push direto na `main` (sem PR), a pedido do dono.
