# Planejai

Assistente pessoal no WhatsApp, no estilo do Instinct. Numa conversa só, ele pesquisa na internet, manda prints e gravações de tela, agenda lembretes do jeito que você fala, anota gastos sozinho, fica de olho em preços e notícias e reage às suas mensagens com emoji. Também tem um painel web (PWA) com agenda, finanças, execuções no estilo n8n e administração.

Por dentro, quem trabalha é um **time de agentes de IA que conversam entre si**. O **CTO** (Téo) fala com você e lidera o time. Os especialistas trabalham em paralelo, consultam uns aos outros (`consult_*`) e anotam descobertas num quadro compartilhado. Antes de a resposta sair, o CTO revisa o trabalho e devolve o que estiver incompleto.

---

## Sumário

1. [O que ele faz](#o-que-ele-faz)
2. [Time de agentes e modelos](#time-de-agentes-e-modelos)
3. [Painel](#painel)
4. [Arquitetura](#arquitetura)
5. [Deploy no Portainer (Swarm + Traefik)](#deploy-no-portainer-swarm--traefik)
6. [Variáveis de ambiente](#variáveis-de-ambiente)
7. [WhatsApp](#whatsapp)
8. [Telegram e n8n](#telegram-e-n8n)
9. [Segurança e privacidade](#segurança-e-privacidade)
10. [Operação: backup, rollback e saúde](#operação-backup-rollback-e-saúde)
11. [Desenvolvimento](#desenvolvimento)
12. [Estrutura do código](#estrutura-do-código)

---

## O que ele faz

- **Entende tudo que chega.**
  - Texto e áudio, que é transcrito.
  - Foto, descrita por visão, com leitura de comprovantes.
  - Vídeo, por quadros e fala.
  - Documentos: PDF, Word, Excel, CSV e TXT são lidos localmente, sem gastar token. PDF escaneado vai para OCR.
  - Localização e respostas citadas.
- **Jeito humano.**
  - Junta mensagens seguidas antes de responder, marca como lida e mostra "digitando…".
  - Divide a resposta em balões e escreve sem marcadores de lista.
  - Primeiro reage com um emoji do assunto, sem IA. Quando alguém manda só "ok" ou "valeu", ele apenas reage.
  - Em pesquisas, avisa antes ("deixa eu ver aqui").
- **Lembretes naturais.** O lembrete guarda a intenção, e na hora certa o CTO escreve a mensagem com contexto. Podem ser únicos ou recorrentes, e o lembrete sai da memória depois de disparar.
- **Gastos automáticos.**
  - Basta contar que gastou ou mandar comprovante, Pix, nota ou fatura: o lançamento é feito na hora, sem duplicar.
  - A categoria é escolhida sozinha. Dá para definir limites por categoria, com aviso em 80% e em 100%.
  - Parcelas fecham no centavo, e gráficos são gerados sem IA.
- **Pesquisa com navegador gravada.** O Pesquisador abre um navegador de verdade, clica, preenche e rola a página. Se você pedir, ele manda o vídeo da tela (MP4).
- **De olho.** Acompanha preços (Mercado Livre) e notícias a cada 15 minutos, sem IA. Só quando algo melhora o modelo escreve o aviso.
- **Imagens sob pedido.** Mapa mental, lista, passo a passo, tabela e frase: a IA escreve só o conteúdo e o servidor monta o PNG.
- **Reunião noturna do time (19h).** Uma chamada barata por pessoa ajusta o estilo de conversa e dá dicas para cada especialista. Ela também libera abas novas no painel e cria agentes sob medida para cada cliente.
- **Convites pelo WhatsApp.** A entrada é só por convite. O convite chega no WhatsApp, a pessoa responde SIM ou NÃO e as duas viram contatos uma da outra ("manda esse look pro Giovani").
- **Pouco token.**
  - O CTO resolve sozinho o que é simples.
  - Especialistas sem integração saem do time.
  - O contexto é curto e a saída é limitada por rota.
  - Buscas, páginas e mídia ficam em cache no Redis.

## Time de agentes e modelos

| Agente | O que faz | Modelo padrão (OpenRouter) |
| --- | --- | --- |
| CTO (Téo) | Conversa, reage, guarda memórias, delega e escreve a resposta | `deepseek/deepseek-v4.1-flash` |
| Pesquisador | Busca na web, lê páginas, tira prints, usa o navegador gravado | `xiaomi/mimo-v2.6-flash` |
| Agenda | Lembretes e Google Agenda | `deepseek/deepseek-v4.1-flash` |
| Financeiro | Gastos, receitas, limites, gráficos e links de pagamento | `deepseek/deepseek-v4.1-flash` |
| Comunicação | Gmail e Slack | `deepseek/deepseek-v4.1-flash` |
| Produtividade | Notion, Linear, GitHub e n8n | `deepseek/deepseek-v4.1-flash` |
| Áudio, foto e resumo | Transcrição, visão e compactação da memória | `qwen/qwen3.8-omni-flash`, `xiaomi/mimo-v2.6-flash` |

Todos os modelos têm fallback. Para trocar, use a tela **Modelos**, que mostra os preços do catálogo do OpenRouter ao vivo e não precisa de redeploy. O motivo de cada escolha está em `apps/server/src/llm/router.ts`.

## Painel

PWA instalável no celular e no notebook, com tema claro e escuro, puxar para atualizar e uma pílula "Atualizar" quando sai versão nova. O mascote do app é o Mochi.

- **Para todo mundo:**
  - Início: painel editável com widgets.
  - Agenda, no estilo Google Agenda.
  - Finanças: visão geral, lançamentos e limites.
  - De olho.
  - Minha conta: perfil, senha, conexões, sair de todos os aparelhos e apagar a conta.
  - Abas extras (Convites, Memórias, Meu time e abas sob medida) são liberadas pela reunião noturna ou pelo dono.
- **Só para o dono da stack (super admin):**
  - Clientes: cadastro, uso, abas, custo por pessoa por dia e apagar dados.
  - Execuções: canvas do fluxo e entrada e saída de cada passo.
  - Filas, Agentes, Time, Integrações, Modelos, WhatsApp e Configurações (travas de segurança).

O dono é a conta de `ADMIN_EMAIL` e é o único super admin. Quem entra por convite vira admin e vê apenas os próprios dados. Isso é garantido no servidor, não só escondido na tela.

## Arquitetura

```
WhatsApp (Baileys / Evolution / Cloud)    Telegram    n8n (API interna)
              │                               │            │
              ▼                               ▼            ▼
         ┌──────────────────────── app (ROLE=api) ────────────────────────┐
         │ Fastify: webhooks, API do painel, API interna, dashboard (PWA) │
         └───────────────────────────────┬────────────────────────────────┘
                                         │ pg-boss (filas no Postgres)
         ┌──────────────────────── worker (ROLE=worker) ──────────────────┐
         │ conexão do WhatsApp, CTO + especialistas, lembretes, convites,  │
         │ De olho, reunião das 19h, limpeza                               │
         └──────┬───────────────┬────────────────┬─────────────────┬──────┘
                ▼               ▼                ▼                 ▼
         db (Postgres 16)  redis (memória)  redis-cache (cache)  browserless
                │
             backup (pg_dump diário)
```

- **Backend:** Node 22, TypeScript e Fastify. Filas e agendamentos usam o pg-boss no próprio Postgres, como o modo fila do n8n: `WORKER_CONCURRENCY` controla quantos jobs rodam em paralelo.
- **Uma imagem só** para app e worker, publicada para amd64, arm64 e arm/v7.
- **Memória curta no Redis.** A conversa fica 24h já interpretada e depois vira resumo. O chat não é guardado no Postgres, porque já está no WhatsApp.
- **Conexão do WhatsApp** guardada no banco, com um "aluguel" que garante uma única conexão mesmo durante o redeploy.

## Deploy no Portainer (Swarm + Traefik)

A stack segue o mesmo padrão do n8n do servidor: Traefik na rede externa `network_public`, entrypoint `websecure` e certificado `letsencryptresolver`. Postgres e Redis são **da própria stack**, nunca os que já existem no servidor.

1. **Imagem.** Cada push na `main` roda o workflow `CI`. Se os testes passarem, ele publica `ghcr.io/dhqdev/planejai-plataform` com as tags `latest` e `sha-XXXXXXX`.
   - O pacote do GHCR nasce privado. Torne-o público em *GitHub > Packages > planejai-plataform > Settings*, ou cadastre o registry `ghcr.io` no Portainer com um token `read:packages`.
2. **Stack.** No Portainer, abra *Stacks > Add stack*, cole [`deploy/swarm-traefik-stack.yml`](deploy/swarm-traefik-stack.yml) e troque todos os valores marcados com `TROQUE`. Gere os segredos com `openssl rand -hex 32`.
   - Para outro domínio, troque `autoplanejai.tekvosoft.com` nas labels do Traefik e no `PUBLIC_URL`.
   - Sem Swarm/Traefik, use [`deploy/portainer-stack.yml`](deploy/portainer-stack.yml), que é um compose comum com porta exposta.
3. **Serviços que sobem:**

   | Serviço | Para quê |
   | --- | --- |
   | `app` | API, webhooks e painel (porta 3000, atrás do Traefik) |
   | `worker` | Agentes, filas e conexão do WhatsApp. Sempre 1 réplica, `stop-first` |
   | `db` | Postgres 16 (volume `planejai_db`) |
   | `backup` | `pg_dump` diário no volume `planejai_backups`, guardado 14 dias, com cópia externa opcional |
   | `redis` | Memória curta, grava em disco e nunca despeja (volume `planejai_redis`) |
   | `redis-cache` | Cache descartável, com despejo LRU |
   | `browserless` | Navegador dos agentes, com versão fixa e numa rede própria sem acesso ao banco |

4. **Primeiro acesso.** Abra o `PUBLIC_URL` e entre com `ADMIN_EMAIL` e `ADMIN_PASSWORD`. As migrações rodam sozinhas no boot.
5. **WhatsApp.** Vá em **WhatsApp** no painel e leia o QR code (veja a [seção WhatsApp](#whatsapp)).
6. **Redeploy automático (opcional).** Crie um webhook do serviço no Portainer e salve a URL no secret `PORTAINER_WEBHOOK_URL` do repositório. O CI chama esse webhook depois de publicar a imagem.

## Variáveis de ambiente

A lista completa, com comentários, está em [`.env.example`](.env.example). As principais:

| Variável | Obrigatória | Para quê |
| --- | --- | --- |
| `PUBLIC_URL` | sim | Endereço público, usado em links de convite, OAuth e webhooks |
| `DATABASE_URL` / `POSTGRES_PASSWORD` | sim | Banco da stack |
| `SESSION_SECRET` | sim (≥32) | Assina o login do painel |
| `ENCRYPTION_KEY` | sim (≥32) | Criptografa as credenciais das integrações. `ENCRYPTION_KEY_OLD` serve para trocar a chave sem perder nada |
| `APP_SECRET` | legado | Só para abrir credenciais antigas. No boot elas são recriptografadas com a `ENCRYPTION_KEY` |
| `INTERNAL_API_KEY` | para o n8n (≥24) | Chave da API interna. Vazia deixa a API desligada |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | sim | Conta do dono (super admin) |
| `OPENROUTER_API_KEY` | sim | Modelos de IA |
| `WHATSAPP_PROVIDER` | sim | `baileys` (padrão), `evolution`, `cloud` ou `none` |
| `WEBHOOK_SECRET` | com Evolution | Segredo do webhook da Evolution |
| `WHATSAPP_CLOUD_*` | com Cloud API | Token, número, verify token e app secret (o app secret é obrigatório) |
| `OWNER_PHONES` | sim | Números do dono, com DDI e só dígitos |
| `ALLOW_UNKNOWN_CONTACTS` | não | `false`: números novos aguardam aprovação |
| `INVITES_PER_DAY` / `INVITE_GAP_SECONDS` | não | Ritmo dos convites, para proteger o número (40 por dia, 45 s) |
| `REDIS_URL` / `REDIS_CACHE_URL` | recomendado | Memória curta e cache |
| `BROWSERLESS_URL` / `BROWSERLESS_TOKEN` | recomendado | Navegador dos agentes |
| `MESSAGE_RETENTION_HOURS` | não | Quanto tempo a conversa fica na memória curta (24) |
| `LOG_CONTENT_HOURS` | não | Depois disso o texto some dos logs de execução (24) |
| `EXECUTION_RETENTION_DAYS` | não | Tempo de guarda de logs, custos e gravações (7) |
| `WORKER_CONCURRENCY` | não | Jobs em paralelo por worker (4, máximo 16) |
| `DEFAULT_TIMEZONE` / `TZ` | não | `America/Sao_Paulo` |

As integrações (Google, Notion, GitHub, Linear, Slack, Tavily, Brave, Mercado Pago, Stripe, Telegram e n8n) não usam variável de ambiente. Elas são configuradas na tela **Integrações** e guardadas criptografadas no banco.

## WhatsApp

- **Baileys (padrão).** O worker conecta direto no WhatsApp Web multi-device. No painel, abra **WhatsApp** e leia o QR code (*Dispositivos conectados > Conectar um dispositivo*) ou use o código de pareamento. A sessão fica no Postgres e se reconecta sozinha.
  - Use um número dedicado ao assistente.
  - Mantenha o `worker` com 1 réplica.
- **Evolution API.** Configure o webhook `{PUBLIC_URL}/webhooks/evolution?secret={WEBHOOK_SECRET}` com o evento `MESSAGES_UPSERT`.
- **Cloud API (Meta).** Configure o webhook `{PUBLIC_URL}/webhooks/whatsapp` com o verify token `WHATSAPP_CLOUD_VERIFY_TOKEN` e o campo `messages`. Exige `WHATSAPP_CLOUD_APP_SECRET`.
- O webhook de um provedor que não está ativo responde 404.
- **Risco de banimento.** O Baileys não é oficial. O guia de boas práticas, o número reserva e o caminho de migração para a Cloud API estão em [`docs/operacao.md`](docs/operacao.md).

## Telegram e n8n

- **Telegram.** Cadastre o bot do dono em Integrações > Telegram. Cada pessoa liga a própria conta em Minha conta > Conexões. Lembretes e avisos saem no canal em que a pessoa está falando.
- **API interna para o n8n.** Toda chamada leva o cabeçalho `X-Planejai-Key: {INTERNAL_API_KEY}`. Endpoints:

  | Endpoint | Para quê |
  | --- | --- |
  | `GET/POST/PATCH /api/internal/users` | Pessoas |
  | `POST /api/internal/send` | Envia texto, imagem, vídeo ou PDF |
  | `POST /api/internal/agent` | O assistente escreve a mensagem do jeito dele |
  | `POST /api/internal/transactions` | Lança um gasto ou receita |
  | `GET /api/internal/finance` | Lê as finanças |

- **Eventos para o n8n.** O app faz POST no "Webhook de eventos" da integração n8n, assinado com `X-Planejai-Signature`. Eventos: `user.created`, `user.activated`, `transaction.created`, `budget.alert`, `reminder.fired` e `telegram.linked`.
- **Ferramentas do assistente.** `n8n_workflows`, `n8n_executions` e `n8n_trigger` (este pede confirmação). Só o dono pode usar.

## Segurança e privacidade

- As integrações da stack (Gmail, Agenda, Notion, Slack, GitHub, Linear, n8n, Mercado Pago e Stripe) são **só do dono**: somem do time de quem não é dono e são recusadas de novo na hora de executar.
- Os agentes não acessam endereços internos ou privados (localhost, IPs da rede, metadata, nomes da stack), nem por redirecionamento.
- Compras, pagamentos e mensagens para terceiros exigem confirmação explícita.
- **Login:**
  - Limite de tentativas por IP e por e-mail.
  - A sessão pode ser revogada: trocar a senha, desativar a conta ou usar "Sair de todos os aparelhos" derruba os outros logins.
  - Senhas com scrypt; credenciais com AES-256-GCM.
- **Travas por pessoa** (Configurações > Travas de segurança): ritmo por minuto, mensagens e custo em 24h, e corte de texto longo.
- **LGPD:**
  - O cadastro exige aceitar os termos ([/privacidade](apps/dashboard/src/pages/Privacy.tsx)).
  - No WhatsApp, a pessoa escreve "apague meus dados" e confirma com "APAGAR TUDO". No painel, use Minha conta > Apagar minha conta.
  - Nos logs, CPF, cartão, chaves e senhas aparecem mascarados, e o texto das conversas some em 24h.

## Operação: backup, rollback e saúde

O guia completo está em [`docs/operacao.md`](docs/operacao.md). Resumo:

- **Backup:** o serviço `backup` faz um dump diário. Para mandar uma cópia para fora do servidor (R2, S3 ou Drive via rclone), preencha `BACKUP_REMOTE`. A restauração é feita com `pg_restore`.
- **Voltar versão:** troque `:latest` por `:sha-XXXXXXX` em `app` e `worker` e atualize a stack.
- **Saúde:**
  - O `app` checa `/health`.
  - O `worker` checa se o processo está vivo e se a conexão do WhatsApp não travou. Se ficar doente, o Swarm reinicia.
- **Custo:** a tela Clientes mostra o custo por dia e por pessoa (7, 30 ou 90 dias).

## Desenvolvimento

```bash
npm ci
cp .env.example .env            # preencha SESSION_SECRET, ENCRYPTION_KEY, ADMIN_PASSWORD, OPENROUTER_API_KEY
docker compose up db redis -d   # ou Postgres e Redis locais
npm run dev                     # API + worker em http://localhost:3000 (migra no boot)
npm run dev:dashboard           # painel em http://localhost:5173, com proxy para :3000
npm run typecheck && npm test   # e2e com TEST_DATABASE_URL; REDIS_URL e CHROME_PATH ligam os testes de Redis e navegador
npm run build                   # o painel vai para apps/server/public
```

Sem WhatsApp, use o canal playground dos testes e veja cada passo em **Execuções**.

## Estrutura do código

```
apps/
  server/src/
    agent/          time de agentes: orchestrator, collab (conversa entre agentes), runner, prompts, trace
    agent/tools/    ferramentas por área: core, research, agenda, finance, communication, productivity, n8n, social, images
    api/            Fastify: server (auth), routes/dashboard, webhooks, internal
    channels/       WhatsApp (Baileys, Evolution, Cloud) e Telegram
    integrations/   conectores e credenciais criptografadas
    llm/            OpenRouter e roteamento de modelos por tarefa
    queue/          pg-boss e worker
    db/migrations/  SQL numerado, roda no boot
    net.ts          bloqueio de endereços internos
    privacy.ts      apagar dados (LGPD)
    healthcheck.ts  healthcheck da imagem
  dashboard/src/    React + Vite (PWA), pages/, mochi/ (mascote)
deploy/             stacks do Portainer (Swarm + Traefik e compose comum)
docs/operacao.md    segredos, backup, rollback, saúde e plano do número
```

Para estender o projeto (ferramenta, integração, especialista ou modelo novo), veja a skill do Claude Code em [`.claude/skills/planejai/SKILL.md`](.claude/skills/planejai/SKILL.md).
