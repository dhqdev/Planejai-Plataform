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
  whatsapp/                session.ts (conexão Baileys: QR, pareamento, reconexão, LISTEN wa_command; aluguel holder/lease_until
                           renovado a cada 15s, vence em 45s, para o worker novo assumir depois de redeploy)
                           auth-state.ts (credenciais/chaves Signal na tabela wa_auth)
  agent/
    orchestrator.ts        processConversation: mídia, contexto (Redis), memórias, CTO, entrega em balões; resumo/compactação
    media.ts               interpreta mídia 1 vez: áudio->texto, foto->descrição (linha FINANCEIRO: p/ comprovantes),
                           documento->texto local (PDF unpdf, DOCX mammoth, XLSX, CSV/TXT/HTML; OCR só p/ PDF escaneado),
                           vídeo->quadros+fala (ffmpeg)
    browser.ts             "computador" dos agentes: puppeteer no browserless (ou CHROME_PATH), snapshot em texto com
                           elementos numerados (barato), ações click/type/press/scroll e gravação em MP4 (screencast + ffmpeg)
    runner.ts              loop de tool-calling (tools em paralelo) + trace de cada passo; respeita o Guard
    guard.ts               travas da execução: prazo (maxExecutionMinutes, padrão 8) e ações (maxToolCalls) para o time
                           todo via ctx.guard; perto do fim manda responder com o que tem; redactSecrets antes do WhatsApp
    collab.ts              TeamRoom: conversa contínua CTO<->especialista (ask_*), consulta entre colegas
                           (consult_*, profundidade máx. 3, sem ciclos) e quadro do time (share_with_team)
    team.ts                SPECIALISTS e CTO_TOOLS — o "organograma" do time
    prompts.ts             prompts do CTO e dos especialistas (pt-BR, estilo WhatsApp)
    trace.ts               executions / execution_steps (logs do dashboard)
    tools/*.ts             ferramentas por domínio (core, research+browser_*, agenda, finance+calculate, communication, productivity)
  llm/openrouter.ts        chat completions com fallback de modelos e custo real (usage.cost)
  llm/router.ts            ROUTE_DEFAULTS: modelo por agente/tarefa; sobrescrito pela tabela model_routes
  integrations/registry.ts INTEGRATIONS: conectores, campos (com help de onde pegar e quais escopos), test() real;
                           credenciais AES-256-GCM no banco; `oauth` marca Google/Mercado Livre (redirectUri na tela)
  integrations/mercadolivre.ts  OAuth do ML: o refresh_token GIRA a cada uso e é salvo de novo; precisa do escopo offline_access
  reminders.ts             lembretes (pg-boss + cron-parser), o CTO escreve a mensagem na hora; o único que disparou é apagado com as memórias criadas junto; reminderOccurrences() expande o cron para a Agenda
  api/server.ts            login (dono ou conta), cadastro, requireAuth/requireSuper
  api/routes/              webhooks.ts e dashboard.ts (REST do painel: bloco com escopo + bloco só super admin)
  db/migrations/*.sql      migrações numeradas, aplicadas no boot
apps/dashboard/src/        React + Vite; App.tsx monta o menu por papel (SUPER_NAV / ADMIN_NAV) e, no celular, a barra de abas
                           (SUPER_TABS / ADMIN_TABS) + "Mais" em bottom sheet; páginas carregadas sob demanda (lazy)
  components.tsx           Modal = bottom sheet no celular (sobe, arrasta pra baixo pra fechar, trava o scroll do fundo)
  touch.ts                 haptic(): navigator.vibrate no Android; no iPhone (iOS 18+) clica um <input switch> escondido dentro do click. Feedback de toque, service worker, prompt de instalação
apps/dashboard/public/     manifest.webmanifest, sw.js (cache só de /assets e /icons; nunca /api) e icons/
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
4. Apelido e carinha: `persona` e `face` (pessoinha a traço: fundo pastel 0-7, olhos, boca, cabelo/acessório em `extra`) no `team.ts`, e a mesma entrada em `CORE_FACES` (`apps/dashboard/src/faces.tsx`).
O CTO ganha automaticamente `ask_<id>` e os outros especialistas ganham `consult_<id>`.

### WhatsApp (Baileys)
- A conexão vive no processo `worker` (ou `all`) e só um processo segura a sessão (`pg_try_advisory_lock`). O worker deve ter 1 réplica.
- A API manda comandos (`connect`, `logout`, `restart`) por `pg_notify('wa_command')`; o status/QR fica em `wa_sessions`, que a tela WhatsApp lê a cada 2s.
- Só reconecta sozinho se a sessão já foi pareada; QR novo só quando alguém pede no dashboard.
- Áudio e foto são baixados na chegada (`downloadMediaMessage`) e o base64 sai do banco depois de transcrito/descrito.
- Não copie código do tekvosoft (AGPL); a implementação aqui é própria, usando só a API pública do Baileys.

### Painéis e permissões
- Dono da stack = `ADMIN_EMAIL`/`ADMIN_PASSWORD` do .env, sempre super admin (id "owner", não fica na tabela). É o ÚNICO super admin: `toAccount` sempre devolve "admin" para conta do banco e as rotas de contas não aceitam `role`. Não reabra isso.
- Entrada só por convite (`signupMode` padrão `invite`; também `approval`, `open`, `closed`). Convite (`social.ts`, fila `invite.send`) chega no WhatsApp; SIM/NÃO é tratado no ingest sem LLM e o aceite cria contatos nos dois sentidos. O link `/convite/CODIGO` abre o cadastro do painel já preenchido; convite vale como aprovação.
- Super admin cadastra cliente completo (nome e sobrenome, e-mail, telefone) em **Clientes** (`POST /api/clients`), que devolve o link para a pessoa criar a senha.
- Contatos: `send_to_contact` ("manda esse look pro Giovani") só envia para quem aceitou o convite.
- Rota nova no `dashboard.ts`: se mostra dados de pessoas, vai no bloco com escopo e filtra com `scopeUserId(req.account)` (null = tudo); se é configuração/custo/sistema, vai no bloco `requireSuper`.
- Abas do cliente (`tabs.ts`, `GET /api/me/tabs`): todo mundo começa só com Início, Agenda, Finanças e De olho. Módulos (`OPTIONAL`: convites, memorias, meu_time) e até 3 abas sob medida (`/aba/:slug`, feitas de widgets do Painel) são liberados pela reunião noturna ou pelo super admin em Clientes. Rota de módulo no `App.tsx` só existe se `has(modulo)`.
- Visual: neutro; o degradê da marca (`--grad`: #FF7A1A, #FF4458, #E23382, #8B2BE2) em pontos de destaque: item ativo do menu e da barra, topo do card de Finanças, barras de limite, borda do Téo, hoje na agenda, avatar, botão Convidar/Atualizar (`.btn-brand`). Ícones de indicadores e categorias usam um tom da paleta (`.tone-ico`, `--c`). Categorias usam a paleta (`CATEGORY_COLORS`, igual à dos gráficos). Não pinte o resto.
- Fluidez: `useApi` (`hooks.ts`) guarda as respostas em memória e mostra na hora ao voltar para a tela, atualizando por trás; o `App.tsx` baixa o código das telas e esquenta as rotas mais usadas logo após o login. Puxar para atualizar (`PullToRefresh.tsx`) dispara `refreshAll()`, sem recarregar a página.
- Versão nova: o build grava `version.json` e troca o `VERSION` do `sw.js` (`vite.config.ts`). `update.ts` confere ao abrir, ao voltar para o app e a cada 5 min e mostra a pílula "Atualizar" (celular e notebook). Não ponha cache em `/version.json`.
- Página nova no dashboard: rota em `App.tsx` dentro do ramo certo (`isSuper` ou admin) e item no menu com ícone de `icons.tsx` (nada de emoji). Widget novo do Painel: entrada em `WIDGETS` de `pages/Dashboard.tsx` (tamanhos s/m/l/xl; o layout de cada conta fica em `/api/me/dashboard`). O teste `features.e2e.test.ts` confere que admin leva 403 nas rotas de super admin; acrescente as novas lá.

### Memória curta, retenção e mídia
- Contexto do CTO = últimas `HISTORY_LIMIT` entradas do Redis (texto já interpretado) + resumo da conversa + memórias. Não volte a mandar mídia crua ou documento inteiro para o LLM: documento entra com prévia de 2.500 caracteres e o resto via `read_document`.
- Conversa não é guardada no Postgres quando o Redis está no ar: a mensagem é apagada depois de processada e a resposta não é gravada (o histórico já está no WhatsApp). Sem Redis, cai no modo antigo (guarda `MESSAGE_RETENTION_HOURS` e resume).
- Cache no Redis (`shortmem.ts`: `cached`, `markSeen`, `countInWindow`): resultado de web_search/fetch_url (6h) e Mercado Livre (1h), interpretação de mídia por hash (30 dias), texto de documento (24h), dedupe de webhook e ritmo por minuto. Ferramenta nova determinística pode entrar no cache do runner (`agent/cache.ts`).
- Gravações e prints ficam em `media_files` (servidos por `/api/media/:id`) por `EXECUTION_RETENTION_DAYS`.

### Ritmo das respostas (estilo Instinct)
- `agent/progress.ts`: mantém o "digitando..." ligado e manda avisos curtos. A frase que o CTO escreve junto de um `ask_*` sai na hora ("deixa eu ver aqui 🔎"); se ele não escrever nada, um aviso de reserva sai após 7s e outro aos 45s (máx. 3 por execução, sem LLM).
- Resposta junto de `react_to_message`/`save_memory` é entregue sem outra rodada do modelo (pergunta simples = 1 chamada). Não quebre isso ao mexer no runner.
- A primeira coisa de toda execução é a reação temática instantânea (`agent/reaction.ts`, regex, sem IA): cinema 🍿, gasto 💸, viagem ✈️... O CTO não reage de novo; só troca por ✅ quando conclui uma tarefa. Tema novo = linha nova em THEMES (a ordem importa).
- "valeu", "ok", "kkk" ou só emoji (isAckOnly em `agent/reaction.ts`): a reação responde e o CTO nem é chamado. "ok"/"sim" contam como pergunta respondida se a última fala do assistente terminou com "?".
- Todo texto que sai (balões, avisos, notifyUser) passa por `humanize()` (`agent/humanize.ts`): sem "-", "•" ou travessão, para soar como gente. Não reintroduza listas com marcador no prompt.
- Dashboard: `/agenda` (pages/Calendar.tsx, estilo Google Agenda: painel lateral com Criar, minicalendário e agendas Lembretes/Google/Feriados no Brasil calculados no front; Dia/Semana/Mês/Lista; semana começa na segunda; no celular pílulas e botão + flutuante; antes era mês/semana/lista, arrastar lembrete único chama PATCH /api/reminders/:id, Google Agenda aparece só para o dono); Finanças com abas Visão geral (KPIs, insight sem IA em `buildInsight`, rosca por categoria, limites e próximos lembretes) e Lançamentos; barra de baixo do celular é uma cápsula flutuante com todas as abas, rolando para os lados; "Mais" no celular é grade de quadrados; no celular o Painel troca os botões de canto por uma linha Ajustes/Editar/Convidar.

### Reunião noturna do time e proatividade
- `improve.ts` (fila `improve.daily`, 19h no `DEFAULT_TIMEZONE`): a "reunião" do Téo (CTO) é UMA chamada barata em JSON por pessoa ativa. Ela devolve: `style` (vai para `users.style_notes` e entra no prompt do CTO), `agent_notes` (uma dica por especialista em `agent_notes`, entra no prompt dele via `collab.ts`), `tabs` (libera módulos e no máximo 1 aba nova por noite) e `create` (agente do cliente com `persona`; a carinha sai de `faceFor(userId:slug)`). Assuntos somam em `user_topics` e viram agente (`client_agents`, até 3, ferramentas só de `CLIENT_AGENT_TOOLS`) quando aparecem em 2 dias diferentes. Botão "Reunião agora" em Agentes.
- Uso por cliente (super admin, Clientes > pessoa): `GET /api/clients/:id/usage` traz execuções, custo, mensagens por dia, quem trabalhou (por agente), agentes criados, o que o time aprendeu e as abas (`PUT /api/clients/:id/tabs`).
- `watches.ts` (fila `watch.check`, a cada 15 min): preço (Mercado Livre) e notícias (busca) são conferidos sem LLM; só quando algo melhora o modelo `proactive` escreve o aviso.

### Gastos automáticos
- Foto/documento de comprovante: a visão escreve `FINANCEIRO: tipo=...; valor_total=...; data=...; estabelecimento=...`; o CTO chama `add_transaction` direto com `message_id` (vira `external_ref`, então reprocessar não duplica).
- Parcelado: `installments` com o valor TOTAL; `splitInstallments` distribui os centavos.
- Respostas das tools financeiras já vêm formatadas (`brl`) para o modelo não errar conta.
- Categoria é opcional em `add_transaction`: `autoCategory` usa o histórico da pessoa (mesmo lugar/descrição), depois `CATEGORY_RULES` (regex sem acento), depois "Outros". Regra nova = linha em `CATEGORY_RULES`.
- Limites (`budgets`, categoria NULL = total do mês): `set_budget`/`budget_status`; `add_transaction` devolve `budget_alert` uma vez ao passar de 80% e uma vez ao estourar (por mês). No painel: Finanças > Limites do mês (`PUT /api/budgets`, valor 0 remove).
- Gráficos (`charts.ts`, `make_chart`: categorias, meses, dias, limites): números do SQL, SVG próprio com a paleta, PNG pelo browserless da stack (ou `CHROME_PATH` em dev). Sem LLM; sai como mídia `[[media:ID]]`.
- Imagens simples sob pedido (`images.ts`, `make_image`: mapa_mental, lista, passos, tabela, frase): a IA escreve só o conteúdo em JSON, o HTML é montado no servidor e vira PNG por `htmlToPng` (página inteira). CTO, Pesquisador e agentes de cliente têm a ferramenta; o prompt proíbe dizer que não consegue gerar imagem.
- Layout no notebook (`FIT_QUERY` em hooks.ts = min-width 1024 e min-height 680): páginas com classe `fit` cabem na tela sem rolar (Painel, Finanças, Agenda, Agentes, Configurações); listas rolam dentro dos cartões. Abaixo disso (zoom, telas baixas, celular) volta o layout normal com rolagem. Abas/filtros ativos usam fundo `--ink`; botões com texto branco usam `--grad-strong` (mais escuro, `background-origin: border-box`). Números em `--mono` e rótulos pequenos em caixa alta, como em Finanças.

### Navegador (pesquisa gravada)
- Ferramentas do Pesquisador: `browser_open` (record/send_recording), `browser_action`, `browser_screenshot`, `browser_close`. A sessão fica em `ctx.room.browser`; o orquestrador fecha o que ficou aberto e manda a gravação se ela foi pedida.
- Precisa de ffmpeg (já na imagem) e do browserless da stack (`TIMEOUT` 300000). Em dev: `CHROME_PATH=/caminho/do/chrome`.

### Filas (como o modo fila do n8n)
- Tudo passa pelo pg-boss (`queue/boss.ts`): mensagem vira job `conversation.process` (prioridade 10), lembretes, resumos, convites, De olho e reunião noturna têm fila própria com retry. `WORKER_CONCURRENCY` (padrão 4) = jobs em paralelo por réplica do worker; para escalar, aumente isso ou suba réplicas (a conexão do WhatsApp continua em um só processo pelo lock).
- Tela **Filas** (super admin, `GET /api/queues`): na fila, rodando, feitos e falhas em 24h, tempo médio e de espera; falha pode ser reprocessada (`POST /api/queues/:name/:id/retry`).

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
Sem WhatsApp, teste pelos e2e (canal playground) e veja os passos em **Execuções**.

## Publicar
- Push na `main` dispara `.github/workflows/docker.yml`: imagem `ghcr.io/dhqdev/planejai-plataform` para amd64, arm64 e arm/v7, e redeploy no Portainer se o secret `PORTAINER_WEBHOOK_URL` existir.
- Stack: `deploy/portainer-stack.yml` (compose comum) ou `deploy/swarm-traefik-stack.yml` (Swarm + Traefik em network_public, domínio autoplanejai.tekvosoft.com). Postgres e Redis são da própria stack; nunca aponte para os que já existem no servidor.
- O Dockerfile só roda `apk add ffmpeg` na arquitetura alvo; o resto das deps é JS puro. Não adicione dependência nativa no servidor sem ajustar isso.

## Regras do projeto
- Travas (Configurações > Travas de segurança, chaves em settings.ts/GUARD_LIMITS): ritmo por minuto no ingest, limite de
  mensagens e de custo em 24h por pessoa no orchestrator (dono isento), corte de texto longo. Toda trava que age vira passo
  "trava: …" em Execuções. Ferramenta nova que demora deve aceitar ser abandonada (o runner usa guard.race).
- PWA: ao mudar o sw.js, suba `VERSION` para limpar o cache antigo. O servidor manda `no-cache` em index/sw/manifest e
  `immutable` em /assets. Todo modal novo usa `<Modal>` (vira bottom sheet sozinho); botão de ação chama `haptic()`.
- Integração nova: campos com `help` dizendo onde pegar o valor, `test()` que bate na API de verdade e, se for OAuth,
  rota `/api/integrations/<id>/oauth/start|callback` com `state` assinado (`oauth:` no sub).
- Segredos só por variável de ambiente ou pela tela de Integrações (criptografados). Nada de chave no código.
- Textos para o usuário final em português do Brasil, tom natural de WhatsApp, sem templates fixos.
- Toda chamada de LLM e de tool passa pelo `Tracer` para aparecer em Execuções.
- Push direto na `main` (sem PR), a pedido do dono.
