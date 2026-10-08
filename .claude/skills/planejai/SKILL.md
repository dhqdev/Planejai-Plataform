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
                           renovado a cada 15s, vence em 45s, para o worker novo assumir depois de redeploy).
                           Pareado = creds.account + me (registered só vale no código de pareamento!). Queda de sessão
                           pareada vira status 'reconnecting' + backoff 2s..60s sem desistir; só loggedOut/403 pede QR.
                           Vigia na batida derruba socket meio-aberto (sem tráfego 90s); envio espera religar (ready()).
                           Teste com socket falso: test/whatsapp-reconnect.e2e.test.ts
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
  errands.ts               recados: o assistente fala com um estabelecimento pela pessoa (detalhes em agentes.md)
  reminders.ts             lembretes (pg-boss + cron-parser), o CTO escreve a mensagem na hora; o único que disparou é apagado com as memórias criadas junto; reminderOccurrences() expande o cron para a Agenda
  api/server.ts            login (dono ou conta), cadastro, requireAuth/requireSuper
  api/security.ts          cabeçalhos de segurança (CSP no HTML com hash do script inline, nosniff, DENY), erro do Postgres
                           nunca vai ao navegador (id malformado = 404) e TRUST_PROXY (padrão: 1 salto vindo da rede interna)
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

### Adicionar uma ferramenta
1. Crie com `defineTool` no arquivo do domínio em `agent/tools/` (JSON Schema em `parameters`, use `obj()`). Descrição curta: a definição vai em **toda** chamada do agente; regra de comportamento mora no prompt, e guia longo (como o formato do n8n) volta no resultado quando o agente precisa (ex.: `automation_save` com `nodes=[]`).
2. Se depende de conector, ponha `integration: "<id>"`: a tool some do agente enquanto não estiver conectada.
3. Ação com dinheiro, que fala com terceiros ou apaga: inclua `...CONFIRM_PARAM` (marcador vazio: não manda nada ao modelo) e comece com `const c = await requireConfirmation(args, resumo, ctx); if (c) return c;`. O servidor guarda e só executa depois do "sim" da pessoa (ver `agentes.md`). Se só lê, confira se o nome cai em `NO_SIDE_EFFECT` (`orchestrator.ts`).
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

## Regras do projeto
- Travas (Configurações > Travas de segurança, chaves em settings.ts/GUARD_LIMITS): ritmo por minuto no ingest, limite de
  mensagens e de custo em 24h por pessoa no orchestrator (dono isento), corte de texto longo. Toda trava que age vira passo
  "trava: …" em Execuções. Ferramenta nova que demora deve aceitar ser abandonada (o runner usa guard.race).
- PWA: ao mudar o sw.js, suba `VERSION` para limpar o cache antigo. O servidor manda `no-cache` em index/sw/manifest e
  `immutable` em /assets. Todo modal novo usa `<Modal>` (vira bottom sheet sozinho); botão de ação chama `haptic()`.
- Integração nova: campos com `help` dizendo onde pegar o valor, `test()` que bate na API de verdade e, se for OAuth,
  rota `/api/integrations/<id>/oauth/start|callback` com `state` assinado (`oauth:` no sub).
- Segredos só por variável de ambiente ou pela tela de Integrações (criptografados). Nada de chave no código. `SESSION_SECRET` assina sessões, `ENCRYPTION_KEY` (+ `ENCRYPTION_KEY_OLD` na troca) cifra credenciais, `INTERNAL_API_KEY` é sempre explícita (vazia = API interna e eventos desligados). `APP_SECRET` é só legado/fallback; no boot `reencryptStale` regrava o que estava na chave antiga.
- Integrações da stack são do dono: ferramenta de integração em `OWNER_INTEGRATIONS` (runner.ts: n8n, Mercado Pago, Stripe) ou com `ownerOnly: true` some do time de quem não é dono e é recusada de novo na execução. Integração nova da stack entra nessa lista.
- Contas pessoais (`PERSONAL_INTEGRATIONS` em registry.ts: Google, Notion, GitHub, Linear, Slack) são de cada um: o dono usa as da tela Integrações, o cliente só as que conectou em Minha conta (tabela `user_integrations`). `getCredentials` lê a pessoa da conversa (`asPerson`/`currentPerson` em `integrations/person.ts`); o runner e o `confirm.ts` rodam toda ferramenta dentro de `asPerson(personOf(ctx.user))`. Código novo que chama ferramenta ou `isConnected` de integração pessoal fora do runner precisa do mesmo `asPerson`, senão cai na conta da plataforma.
- Toda URL que vem do usuário, do modelo ou de página passa por `net.ts` (`checkedUrl`/`assertPublicUrl`/`safeFetch`): bloqueia IP privado, loopback, metadata e nomes internos, inclusive em redirecionamento. Nunca use `fetch(url)` cru com URL externa. Em teste, `ALLOW_PRIVATE_URLS=true`.
- Webhooks: o do canal que não é o `WHATSAPP_PROVIDER` responde 404; Evolution exige `WEBHOOK_SECRET` e Cloud exige `WHATSAPP_CLOUD_APP_SECRET` (comparação em tempo constante).
- Sessão: o token leva `v` = `accounts.session_version` (dono: settings + hash da senha); trocar senha, desativar ou "Sair de todos" sobe a versão. Login tem limite por IP e por e-mail (`ratelimit.ts`); cadastro e convite também.
- Privacidade: Execuções mascaram CPF, cartão, chave e senha (`maskPersonal` em trace.ts) e o texto some após `LOG_CONTENT_HOURS` (`content_purged`). "apague meus dados" no WhatsApp pede "APAGAR TUDO" e roda `eraseUserData` (`privacy.ts`, sem LLM); no painel `DELETE /api/me` e, para o super admin, `DELETE /api/clients/:id`. Cadastro exige `accept_terms`; texto em `/privacidade` (pages/Privacy.tsx).
- Custo: `usage_daily` soma execuções, tokens e custo por pessoa por dia (o Tracer atualiza). Clientes mostra o gráfico (`GET /api/costs?days=`, super admin).
- Erro transitório do LLM (429/5xx/timeout/rede) não marca a mensagem como processada: o job do pg-boss tenta de novo. Convites têm ritmo (`INVITES_PER_DAY`, `INVITE_GAP_SECONDS`) para não queimar o número.
- Textos para o usuário final em português do Brasil, tom natural de WhatsApp, sem templates fixos.
- Toda chamada de LLM e de tool passa pelo `Tracer` para aparecer em Execuções.
- Push direto na `main` (sem PR), a pedido do dono.

## Onde está o resto

Leia só o arquivo do assunto que você vai mexer (ficam nesta pasta):

| Arquivo | Assunto |
| --- | --- |
| `agentes.md` | confirmação de ação sensível, memória curta, ritmo das respostas, reunião noturna, time de cada pessoa, navegador, filas, modelos |
| `painel.md` | permissões, telas particulares, abas, menu, visual, PWA, agenda e finanças no painel |
| `financas.md` | gastos automáticos, limites, gráficos, imagens, assinatura do Asaas, regras financeiras, contas fixas |
| `integracoes.md` | WhatsApp (Baileys), Telegram, API interna, eventos e n8n, automações, notificações, documentos, código de login |
| `deploy.md` | rodar e testar local, CI, imagem, stacks, versões, migrações |

Mudou um comportamento descrito aqui ou num desses arquivos? Atualize o texto no mesmo commit. Sem histórico ("antes era..."): o git guarda isso.
