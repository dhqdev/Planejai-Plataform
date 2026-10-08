# Operação do Planejai

Guia curto para quem cuida da stack: segredos, backup, voltar versão, saúde dos serviços e o número do WhatsApp.

## Segredos

| Variável | Para quê | Trocar |
|---|---|---|
| `SESSION_SECRET` | assina o login do painel e o segredo do webhook do Telegram | troque à vontade; todo mundo entra de novo e o webhook do Telegram é registrado de novo no boot |
| `ENCRYPTION_KEY` | criptografa as credenciais das integrações | mova a atual para `ENCRYPTION_KEY_OLD`, ponha a nova e atualize: o boot recriptografa tudo. Depois de um boot pode tirar a antiga |
| `INTERNAL_API_KEY` | API interna usada pelo n8n (`X-Planejai-Key`) | troque e atualize a chave nos nós do n8n. Vazia = API interna desligada |
| `APP_SECRET` | legado (antes fazia tudo) | só serve para abrir credenciais antigas; depois do primeiro boot com `ENCRYPTION_KEY` pode sair |
| `ADMIN_PASSWORD` | senha do dono | trocar derruba todos os logins do dono |

Gere com `openssl rand -hex 32` (a do n8n pode ser `openssl rand -hex 24`).

## Backup do banco

O serviço `backup` faz um `pg_dump` por dia (formato custom) no volume `planejai_backups` e guarda 14 dias.
O backup tem dados pessoais e a sessão do WhatsApp: guarde a cópia externa num bucket privado.

**Cópia fora do servidor (recomendado).** Preencha `BACKUP_REMOTE` e as variáveis do rclone no serviço `backup`. Exemplo com Cloudflare R2:

```
BACKUP_REMOTE: r2:planejai-backups
RCLONE_CONFIG_R2_TYPE: s3
RCLONE_CONFIG_R2_PROVIDER: Cloudflare
RCLONE_CONFIG_R2_ACCESS_KEY_ID: ...
RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: ...
RCLONE_CONFIG_R2_ENDPOINT: https://<conta>.r2.cloudflarestorage.com
```

**Conferir:** os logs do serviço `backup` mostram `backup ok: /backups/planejai-AAAAMMDD-HHMM.dump`.

**Restaurar:**

```sh
# 1. pare app e worker (Portainer > serviço > scale 0)
# 2. no container do backup:
pg_restore --clean --if-exists --no-owner -d planejai /backups/planejai-AAAAMMDD-HHMM.dump
# 3. volte app e worker para 1 réplica
```

## Voltar uma versão

A imagem só é publicada depois que os testes passam (workflow `CI`). Cada build gera duas tags: `latest` e `sha-XXXXXXX` (o commit).
Para voltar, troque `:latest` por `:sha-XXXXXXX` nos serviços `app` e `worker` e atualize a stack. Para voltar ao normal, ponha `:latest` de novo.

## Saúde dos serviços

- `app`: o healthcheck chama `/health` (que testa o banco).
- `worker`: o healthcheck confere se o processo está vivo e se a conexão do WhatsApp que ele segura não travou (sem batida há 90 s, ou "conectando" há mais de 5 min). Doente três vezes seguidas, o Swarm reinicia.
- `redis`: memória curta das conversas, grava em disco e nunca apaga chave sozinho. Se encher, o app volta a guardar as mensagens no Postgres até ter espaço.
- `redis-cache`: cache descartável com despejo LRU.
- `browserless`: fica numa rede só com app e worker, sem acesso ao banco. Os agentes também recusam endereços internos e privados.

## Privacidade

- Mensagens: 24 h na memória curta, depois viram resumo.
- Logs de execução: o texto some depois de `LOG_CONTENT_HOURS` (24 h); custo, tempo e modelo ficam por `EXECUTION_RETENTION_DAYS` (7 dias). O custo por pessoa e por dia fica em `usage_daily` (gráfico em Clientes).
- Termos e política: `/privacidade`. Cadastro exige aceite; o SIM do convite também vale como aceite.
- Exclusão: a pessoa manda "apague todos os meus dados" e confirma com APAGAR TUDO, ou usa Minha conta > Apagar minha conta. O dono pode apagar em Clientes > Apagar dados.

## O número do WhatsApp

O Baileys usa o WhatsApp Web de um número comum, sem garantia da Meta. Se o número for banido, o assistente para para todo mundo.

**O que o app já faz para reduzir o risco**
- Convites espaçados (`INVITE_GAP_SECONDS`, 45 s), teto de `INVITES_PER_DAY` (40) por dia para o número e 10 por pessoa por dia.
- Convite só sai depois de alguém pedir, com SIM/NÃO; quem diz NÃO não recebe mais nada.
- Ritmo por conversa (no máximo uma resposta por minuto para quem manda mensagem demais) e limite diário por pessoa.
- Avisos proativos só quando um acompanhamento acha algo de verdade.

**Boas práticas**
- Use um número que já tem histórico (não um chip novo), com foto, nome e recado preenchidos.
- Aqueça o número: nos primeiros dias, poucos convites e mais conversas iniciadas pelas pessoas.
- Peça para quem entrar salvar o contato: mensagem para quem tem o número salvo quase nunca é denunciada.

**Número reserva (plano B rápido)**
1. Tenha um segundo chip com WhatsApp ativo e aquecido.
2. Se o principal cair: painel > WhatsApp > Desconectar, e conecte o reserva pelo QR.
3. As pessoas continuam cadastradas (o cadastro é pelo número delas, não pelo do assistente). Mande para todas, pelo n8n (`POST /api/internal/send`) ou em lotes, o aviso de que o assistente mudou de número.

**Migração para a API oficial (plano definitivo, antes de abrir para muita gente)**
1. Crie um app na Meta (WhatsApp Business Platform), verifique a empresa e registre um número.
2. Na stack: `WHATSAPP_PROVIDER: cloud`, `WHATSAPP_CLOUD_TOKEN`, `WHATSAPP_CLOUD_PHONE_NUMBER_ID`, `WHATSAPP_CLOUD_VERIFY_TOKEN` e `WHATSAPP_CLOUD_APP_SECRET` (sem ele o webhook recusa tudo).
3. Webhook na Meta: `https://<seu domínio>/webhooks/whatsapp` com o mesmo verify token.
4. Atenção às diferenças: fora da janela de 24 h depois da última mensagem da pessoa, só sai mensagem com template aprovado (convites, lembretes e avisos proativos precisam de template), e cada conversa iniciada pela empresa é cobrada pela Meta.

## Repositório e imagem privados

O app não depende do GitHub para rodar: a pílula "Atualizar" do painel lê o `/version.json` do próprio servidor. A única coisa que vem do GitHub é a imagem `ghcr.io/dhqdev/planejai-plataform`, e a visibilidade dela é separada da do repositório.

Ordem para nunca deixar o servidor sem conseguir puxar a imagem:

1. Token clássico só com `read:packages` (*GitHub > Settings > Developer settings > Personal access tokens > Tokens (classic)*). Tokens fine-grained não funcionam no GHCR.
2. *Portainer > Registries > Add registry > Custom registry*: URL `ghcr.io`, usuário `dhqdev`, senha = token. No Swarm o Portainer repassa a credencial aos nós ao atualizar a stack.
3. Teste: *Update the stack* com "Re-pull image" ligado. Tem que funcionar ainda com a imagem pública.
4. Repositório privado: *Settings > General > Danger Zone > Change visibility*.
5. Imagem privada: *github.com/users/dhqdev/packages/container/planejai-plataform/settings > Danger zone > Change visibility*. Se o GitHub não deixar voltar para privado, apague o pacote e rode *Actions > CI > Run workflow*: ele recria `latest` e `sha-…` já privados (perde só o rollback para os `sha-…` antigos; o servidor segue com a imagem que já tem).
6. Confira a versão nova no painel ou no `/health` depois do próximo push.

Com o repositório privado o Actions tem 2.000 min/mês no plano grátis. Pushes que só mudam `.claude/`, `docs/` ou arquivos `.md` não rodam o CI.
