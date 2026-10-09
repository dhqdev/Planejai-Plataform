---
name: planejai
description: Guia da plataforma Planejai (assistente no WhatsApp com time de agentes CTO + especialistas, OpenRouter, Baileys, Redis, painel React, deploy no Portainer/Swarm). Use em QUALQUER tarefa neste repositório, antes de abrir código: mapa do app, onde procurar cada coisa, qual modelo usar, como trabalhar com outras sessões no main sem travar, receitas e regras.
---

# Planejai: guia do projeto

Assistente pessoal no WhatsApp no estilo do Instinct: uma conversa só, com um **time de agentes**.
O **CTO** conversa com a pessoa, reage às mensagens e lidera o time; os especialistas conversam entre si e o CTO revisa antes de responder.
Tudo roda em uma imagem (API + worker + dashboard) com Postgres e Redis próprios da stack.

Princípios que não podem quebrar:
- **Time que conversa, não pipeline**: o CTO tem uma conversa contínua com cada especialista (`ask_*`), especialistas consultam colegas (`consult_*`) e escrevem no quadro do time; o CTO revisa e devolve antes de responder.
- **Pouco token**: o simples o CTO resolve com atalhos (gasto, conta, lembrete, memória); mídia é interpretada uma vez e guardada; documentos são lidos localmente; contexto vem do Redis já interpretado; saída limitada por `maxTokens`.
- **Dinheiro exato**: nunca conta de cabeça (`calculate`), valores em centavos (`parseAmount`, `splitInstallments`), totais formatados em BRL pelas ferramentas.

## Comece aqui (2 minutos)

1. **Situe-se no git.** Outras sessões publicam no `main` ao mesmo tempo. O hook de início (`.claude/hooks/inicio.mjs`) já mostra os últimos commits e o que você tem pendente; se ele não rodou: `git fetch origin main && git status -sb && git log --oneline -12 origin/main`.
2. **Leia só o arquivo do assunto** (tabela "Arquivos desta skill" no fim). Não leia a pasta toda.
3. **Ache o código pela tabela "Onde procurar"** abaixo antes de sair abrindo arquivos.
4. **Escolha o modelo/subagente pela tarefa** (`modelos.md`) e siga o protocolo de trabalho em paralelo (`paralelo.md`) para não travar nem pisar no trabalho de outra sessão.

## Onde procurar cada coisa

| Pergunta | Onde olhar |
| --- | --- |
| O que um agente pode fazer? Quem chama quem? | `apps/server/src/agent/team.ts` (`SPECIALISTS`, `CTO_TOOLS`), ferramentas em `agent/tools/<domínio>.ts` |
| Como o agente fala, regras de comportamento | `agent/prompts.ts` (CTO e especialistas); dica por pessoa em `agent_notes`/`users.style_notes` |
| Qual modelo cada agente usa e por quê | `llm/router.ts` (`ROUTE_DEFAULTS`); em produção a tela Modelos grava por cima em `model_routes` |
| Por que o assistente respondeu X? | Painel > Execuções (tabelas `executions` e `execution_steps`); local: e2e com o canal playground |
| Por que travou / respondeu pela metade? | `agent/guard.ts`, `agent/collab.ts`, status `partial` com motivo em `error` (ver `agentes.md`) |
| Variável de ambiente | `apps/server/src/config.ts` + `.env.example` |
| Ajuste que o dono muda no painel (travas, assinatura, cadastro) | `settings.ts` (chaves e faixas) e Configurações no painel |
| Quem vê o quê no painel | `painel.md`, `accounts.ts`, `sharing.ts`, `api/routes/dashboard/shared.ts` |
| Rota do painel | `api/routes/dashboard/<área>.ts` (agenda, finance, clients, executions, integrations, invites, memories, whatsapp) e `api/routes/dashboard.ts` |
| Tela do painel | `apps/dashboard/src/pages/<Tela>.tsx`; menu e abas em `App.tsx` |
| Tabela do banco | `grep -rln "create table <nome>" apps/server/src/db/migrations` |
| Fila / job agendado | `queue/boss.ts` (nomes em `QUEUES`) e `queue/worker.ts` |
| Integração (conector) | `integrations/registry.ts` (`INTEGRATIONS`, `PERSONAL_INTEGRATIONS`) |
| Como algo era antes / quem mexeu | `git log -S "<trecho>" --oneline` e `git log -p --follow <arquivo>` (a skill não guarda histórico) |
| Decisão do dono que não está no código | `CLAUDE.md`, esta skill e a memória do projeto (Claude Projects). Se não estiver em nenhum, veja "Perguntar ao dono" |
| Estado de produção | Não dá para ver do sandbox (OpenRouter e WhatsApp bloqueados). `/health` mostra versão; o resto, pergunte ao David ou use o conector do n8n |

Dica: `rg -n "<nome>" apps/server/src apps/dashboard/src` acha qualquer função, tabela ou texto em segundos. Prefira isso a abrir arquivo por arquivo.

### Perguntar ao dono (David)
- Ele pediu, você faz e conta no fim. Não pergunte de novo o que ele já pediu.
- Detalhe que ele não disse: escolha o padrão razoável, faça e diga qual escolheu.
- Pergunte só quando a resposta muda o objetivo, algo que ele vai notar, ou um passo sem volta (produção, apagar dados, mensagem para gente de verdade). Uma pergunta, respondível com uma palavra, opções em linhas curtas e a sua recomendação marcada.

## Mapa do código

```
apps/server/src/
  index.ts                 entrada; ROLE=all|api|worker|channel|conversations (roles.ts, ver deploy.md)
  config.ts                variáveis de ambiente (zod) — toda env nova entra aqui e no .env.example
  settings.ts              ajustes do painel (travas GUARD_LIMITS, assinatura, cadastro) com faixa permitida
  ingest.ts                webhook -> usuário/conversa/mensagem -> fila (debounce por conversa)
  accounts.ts              contas do painel: dono (.env) = super admin; cadastro = admin (scopeUserId limita os dados)
  sharing.ts               telas particulares e o que um contato liberou (selfUserId, personalUser)
  shortmem.ts              memória curta no Redis (pj:conv:<id>:msgs, TTL = MESSAGE_RETENTION_HOURS); cai pro Postgres se o Redis sumir
  maintenance.ts           de hora em hora: resume e apaga mensagens > 24h, logs e gravações antigas, fecha execuções órfãs
  net.ts                   safeFetch/checkedUrl: toda URL externa passa aqui
  crypto.ts                AES-256-GCM das credenciais (ENCRYPTION_KEY + chaves antigas)
  ratelimit.ts             limites por IP/e-mail (login, cadastro, convite)
  time.ts                  fuso e datas locais
  reminders.ts  watches.ts  improve.ts  errands.ts  bills.ts  billing.ts
                           lembretes, De olho, reunião noturna, recados, contas fixas, assinatura Asaas
  social.ts  onboarding.ts  tabs.ts  privacy.ts
                           convites/contatos, perguntas de boas-vindas, abas do cliente, LGPD (eraseUserData)
  documents.ts  storage.ts  notifications.ts  events.ts  telegram.ts  logincode.ts
                           documentos, sininho, eventos para o n8n, Telegram, código de login
  charts.ts  images.ts     gráficos e imagens simples (HTML -> PNG, sem LLM)
  resources.ts             tela Servidor/Armazenamento
  alive.ts  healthcheck.ts  version.ts
                           vida do worker, healthcheck da imagem, versão
  channels/                baileys.ts (padrão), evolution.ts, cloud.ts (Meta), telegram.ts, PlaygroundChannel; wa-message.ts parseia WAMessage
  whatsapp/                session.ts (conexão Baileys: QR, pareamento, reconexão, LISTEN wa_command), lease.ts (aluguel
                           holder/lease_until renovado a cada 15s, vence em 45s), pairing.ts, inbound.ts, outbound.ts,
                           commands.ts, status.ts, disconnect.ts, auth-state.ts (chaves Signal na tabela wa_auth),
                           rpc.ts/rpc-server.ts (ROLE=conversations envia pelo channel: fila whatsapp.send + NOTIFY).
                           Pareado = creds.account + me. Queda de sessão pareada vira 'reconnecting' + backoff 2s..60s;
                           só loggedOut/403 pede QR. Teste com socket falso: test/whatsapp-reconnect.e2e.test.ts
  agent/
    orchestrator.ts        processConversation: mídia, contexto (Redis), memórias, CTO, entrega em balões; resumo/compactação
    media.ts               interpreta mídia 1 vez: áudio->texto, foto->descrição (linha FINANCEIRO: p/ comprovantes),
                           documento->texto local (PDF, DOCX, XLSX, CSV/TXT/HTML; OCR só p/ PDF escaneado), vídeo->quadros+fala
    runner.ts              loop de tool-calling (tools em paralelo) + trace de cada passo; respeita o Guard
    guard.ts               prazo (maxExecutionMinutes) e ações (maxToolCalls) do time todo; redactSecrets antes do WhatsApp
    collab.ts              TeamRoom: ask_* (CTO<->especialista), consult_* (colegas, cadeia máx. 3, sem ciclos), quadro do time
    team.ts                SPECIALISTS e CTO_TOOLS — o "organograma" do time
    prompts.ts             prompts do CTO e dos especialistas (pt-BR, estilo WhatsApp)
    confirm.ts             "sim"/"não" da pessoa para ação sensível, sem IA
    claims.ts              trava de honestidade: "anotei/apaguei/agendei" só se a ferramenta rodou
    progress.ts  reaction.ts  humanize.ts
                           "digitando" e avisos curtos, reação temática sem IA, texto sem marcador de lista
    receipts.ts            comprovante vira lançamento antes do CTO
    browser.ts             "computador" dos agentes (browserless/CHROME_PATH), snapshot em texto, gravação MP4
    errand-agent.ts        agente que conversa com o estabelecimento nos recados
    cache.ts  trace.ts     cache de ferramenta determinística; executions/execution_steps
    tools/*.ts             ferramentas por domínio (core, research, agenda, finance, bills, communication, productivity,
                           documents, images, places, errands, social, team, automations, n8n); types.ts tem
                           defineTool, requireConfirmation e CONFIRM_PARAM
  llm/openrouter.ts        chat completions com fallback de modelos e custo real (usage.cost)
  llm/router.ts            ROUTE_DEFAULTS: modelo por agente/tarefa; sobrescrito pela tabela model_routes
  integrations/            registry.ts (INTEGRATIONS, credenciais cifradas, test() real), person.ts (asPerson),
                           google.ts e mercadolivre.ts (OAuth)
  queue/                   boss.ts (pg-boss, QUEUES) e worker.ts (consumidores)
  api/server.ts            login (dono ou conta), cadastro, requireAuth/requireSuper
  api/security.ts          cabeçalhos (CSP com hash), erro do Postgres nunca vai ao navegador, TRUST_PROXY
  api/routes/              webhooks.ts, internal.ts (API do n8n), notifications.ts, dashboard.ts + dashboard/<área>.ts
  db/                      pool.ts, migrate.ts, migrations/0NN_*.sql (aplicadas no boot)
apps/server/test/          vitest; *.e2e.test.ts precisam de TEST_DATABASE_URL (e REDIS_URL / CHROME_PATH para partes)
apps/dashboard/src/        React + Vite; App.tsx monta menu (SUPER_NAV / ADMIN_NAV), barra do celular e rotas (lazy)
  pages/                   uma tela por arquivo; pages/executions/ é a tela de Execuções (lista, detalhe, fluxo)
  components.tsx           Modal (bottom sheet no celular), ICONS, AGENT_LABEL
  hooks.ts  api.ts         useApi com cache em memória, FIT_QUERY; cliente HTTP
  faces.tsx  mochi/        carinhas dos agentes; mascote Mochi (Mochi.tsx, Wardrobe.tsx, Parade.tsx)
  touch.ts  update.ts  notify.ts  a11y.ts  motion.css  styles.css (só @import de styles/*.css)
apps/dashboard/public/     manifest.webmanifest, sw.js (cache só de /assets e /icons; nunca /api) e icons/
deploy/                    portainer-stack.yml, swarm-traefik-stack.yml (autoplanejai.tekvosoft.com), n8n-stack.yml
docs/operacao.md           segredos, backup/restore, rollback, saúde
```

## Receitas

### Adicionar uma ferramenta
1. Crie com `defineTool` no arquivo do domínio em `agent/tools/` (JSON Schema em `parameters`, use `obj()`). Descrição curta: a definição vai em **toda** chamada do agente; regra de comportamento mora no prompt, e guia longo (como o formato do n8n) volta no resultado quando o agente precisa (ex.: `automation_save` com `nodes=[]`).
2. Se depende de conector, ponha `integration: "<id>"`: a tool some do agente enquanto não estiver conectada.
3. Ação com dinheiro, que fala com terceiros ou apaga: inclua `...CONFIRM_PARAM` (marcador vazio: não manda nada ao modelo) e comece com `const c = await requireConfirmation(args, resumo, ctx); if (c) return c;`. O servidor guarda e só executa depois do "sim" da pessoa (ver `agentes.md`). Se só lê, confira se o nome cai em `NO_SIDE_EFFECT` (`orchestrator.ts`).
4. Registre a tool no especialista certo em `agent/team.ts` (ou em `CTO_TOOLS` se for núcleo da conversa).
5. Imagens para enviar: `ctx.outbox.addMedia(...)` e devolva o `media_id`; o CTO posiciona com `[[media:ID]]`.
6. Se a tool chama um LLM, devolva `_usage` (o `ChatResult`) para o custo entrar no log.
7. Se a resposta pode dizer "fiz" por causa dela (anotei, apaguei, agendei), acrescente o nome na regra certa de `CLAIMS` (`agent/claims.ts`).

### Adicionar uma integração (conector)
1. Adicione em `INTEGRATIONS` (`integrations/registry.ts`): `id`, `fields`, `category`, `icon`, `test()`.
2. Leia credenciais nas tools com `getCredentials("<id>")`. Nunca logue credenciais.
3. Ícone novo: mapa `ICONS` em `apps/dashboard/src/components.tsx`.
4. Da stack (do dono): `OWNER_INTEGRATIONS` em `runner.ts` ou `ownerOnly: true`. Conta pessoal: `PERSONAL_INTEGRATIONS`.

### Adicionar um especialista
1. Novo item em `SPECIALISTS` (`team.ts`) com `role` claro (é o que o CTO lê para decidir delegar).
2. Nova rota `agent:<id>` em `ROUTE_DEFAULTS` (`llm/router.ts`) com o modelo mais barato que dá conta (critério em `modelos.md`).
3. Rótulo em `AGENT_LABEL` (`apps/dashboard/src/components.tsx`).
4. Apelido e carinha: `persona` e `face` no `team.ts`, e a mesma entrada em `CORE_FACES` (`apps/dashboard/src/faces.tsx`).
O CTO ganha automaticamente `ask_<id>` e os outros especialistas ganham `consult_<id>`.

## Regras do projeto
- Travas (Configurações > Travas de segurança, chaves em `settings.ts`/`GUARD_LIMITS`): ritmo por minuto no ingest, limite de
  mensagens e de custo em 24h por pessoa no orchestrator (dono isento), corte de texto longo. Toda trava que age vira passo
  "trava: …" em Execuções. Ferramenta nova que demora deve aceitar ser abandonada (o runner usa `guard.race`).
- PWA: ao mudar o `sw.js`, suba `VERSION` para limpar o cache antigo. O servidor manda `no-cache` em index/sw/manifest e
  `immutable` em /assets. Todo modal novo usa `<Modal>` (vira bottom sheet sozinho); botão de ação chama `haptic()`.
- Integração nova: campos com `help` dizendo onde pegar o valor, `test()` que bate na API de verdade e, se for OAuth,
  rota `/api/integrations/<id>/oauth/start|callback` com `state` assinado (`oauth:` no sub).
- Segredos só por variável de ambiente ou pela tela de Integrações (criptografados). Nada de chave no código. `SESSION_SECRET` assina sessões, `ENCRYPTION_KEY` (+ `ENCRYPTION_KEY_OLD` na troca) cifra credenciais, `INTERNAL_API_KEY` é sempre explícita (vazia = API interna e eventos desligados). `APP_SECRET` é só legado/fallback; no boot `reencryptStale` regrava o que estava na chave antiga.
- Integrações da stack são do dono: ferramenta de integração em `OWNER_INTEGRATIONS` (runner.ts: hoje só o n8n) ou com `ownerOnly: true` some do time de quem não é dono e é recusada de novo na execução.
- Contas pessoais (`PERSONAL_INTEGRATIONS` em registry.ts: Google, Notion, GitHub, Linear, Slack, Mercado Pago) são de cada um: o dono usa as da tela Integrações, o cliente só as que conectou em Minha conta (tabela `user_integrations`). `getCredentials` lê a pessoa da conversa (`asPerson`/`currentPerson` em `integrations/person.ts`); o runner e o `confirm.ts` rodam toda ferramenta dentro de `asPerson(personOf(ctx.user))`. Código novo que chama ferramenta ou `isConnected` de integração pessoal fora do runner precisa do mesmo `asPerson`, senão cai na conta da plataforma.
- Toda URL que vem do usuário, do modelo ou de página passa por `net.ts` (`checkedUrl`/`assertPublicUrl`/`safeFetch`): bloqueia IP privado, loopback, metadata e nomes internos, inclusive em redirecionamento. Nunca use `fetch(url)` cru com URL externa. Em teste, `ALLOW_PRIVATE_URLS=true`.
- Webhooks: o do canal que não é o `WHATSAPP_PROVIDER` responde 404; Evolution exige `WEBHOOK_SECRET` e Cloud exige `WHATSAPP_CLOUD_APP_SECRET` (comparação em tempo constante).
- Sessão: o token leva `v` = `accounts.session_version` (dono: settings + hash da senha); trocar senha, desativar ou "Sair de todos" sobe a versão. Login tem limite por IP e por e-mail (`ratelimit.ts`); cadastro e convite também.
- Privacidade: Execuções mascaram CPF, cartão, chave e senha (`maskPersonal` em trace.ts) e o texto some após `LOG_CONTENT_HOURS` (`content_purged`). "apague meus dados" no WhatsApp pede "APAGAR TUDO" e roda `eraseUserData` (`privacy.ts`, sem LLM); no painel `DELETE /api/me` e, para o super admin, `DELETE /api/clients/:id`. Cadastro exige `accept_terms`; texto em `/privacidade` (pages/Privacy.tsx).
- Custo: `usage_daily` soma execuções, tokens e custo por pessoa por dia (o Tracer atualiza). Clientes mostra o gráfico (`GET /api/costs?days=`, super admin).
- Erro transitório do LLM (429/5xx/timeout/rede) não marca a mensagem como processada: o job do pg-boss tenta de novo. Convites têm ritmo (`INVITES_PER_DAY`, `INVITE_GAP_SECONDS`) para não queimar o número.
- Textos para o usuário final em português do Brasil, tom natural de WhatsApp, sem templates fixos.
- Toda chamada de LLM e de tool passa pelo `Tracer` para aparecer em Execuções.
- Push direto na `main` (sem PR), a pedido do dono. Protocolo em `paralelo.md`.

## Outras skills do repositório

Ficam em `.claude/skills/` ao lado desta. Use a que casa com a tarefa, sempre respeitando o visual do Planejai descrito em `painel.md` (que vence quando as duas discordam):

| Tarefa | Skill |
| --- | --- |
| Criar animação / transição | `animate` (receitas em RECIPES.md); revisar: `review-animations`; achar onde falta: `find-animation-opportunities`; auditoria geral: `improve-animations`; nome de um efeito: `animation-vocabulary` |
| Tela nova ou repaginada | `frontend-design`, `emil-design-eng`, `apple-design` (gestos, molas, folhas) |
| Celular / PWA | `mobile-native` |
| Testar tela com dado ruim | `break-ui` |
| Revisão de UI e acessibilidade | `web-design-guidelines` |
| Desempenho React | `vercel-react-best-practices` |
| Escolher biblioteca de front | `pick-ui-library`; toasts: `ask-sonner` |
| Variações de uma tela para comparar | `prototype` |
| Arquitetura (módulos rasos, acoplamento) | `improve-codebase-architecture` |
| Achar/instalar skill nova | `find-skills` |

## Arquivos desta skill

Leia só o do assunto que você vai mexer:

| Arquivo | Assunto |
| --- | --- |
| `paralelo.md` | várias sessões no main: começar, commitar, rebase, conflito, CI, testes no sandbox, como não travar |
| `modelos.md` | qual modelo/subagente do Claude usar por tarefa e como escolher os modelos dos agentes do app (OpenRouter) |
| `agentes.md` | time (nomes e papéis), confirmação de ação sensível, travas anti-travamento, memória curta, ritmo, reunião noturna, recados, navegador, filas |
| `painel.md` | permissões, telas particulares, abas, menu, visual, PWA, agenda e finanças no painel |
| `financas.md` | gastos automáticos, limites, gráficos, imagens, assinatura do Asaas, regras financeiras, contas fixas |
| `integracoes.md` | WhatsApp (Baileys), Telegram, API interna, eventos e n8n, automações, notificações, documentos, código de login |
| `deploy.md` | rodar e testar local, CI, imagem, stacks, versões, migrações |

Mudou um comportamento descrito aqui ou num desses arquivos? Atualize o texto no mesmo commit. Sem histórico ("antes era..."): o git guarda isso. O teste `apps/server/test/skills.test.ts` confere que todo arquivo citado entre crases nesta pasta ainda existe; se ele falhar, corrija o texto.
