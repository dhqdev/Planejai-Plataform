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

## Backup e migração (painel > Servidor > Backup)

Com o bucket ligado (`STORAGE_S3_*`, seção abaixo), o próprio app faz o backup todo dia às 3h30 (`DEFAULT_TIMEZONE`), sem rclone:
`pg_dump` do banco inteiro em `banco/` com uma ficha `.json` do lado (versão, quantas pessoas, impressão digital da `ENCRYPTION_KEY`, conferência dos arquivos), 30 dias (sempre ficam os 7 mais novos).
A tela Servidor > Backup (só o dono da stack) mostra o que está salvo, tem "Testar backup agora" (sobe, baixa de volta e confere o hash e o `pg_restore -l`), o cofre das chaves, o passo a passo para migrar e o botão de restaurar.

Pastas no bucket (dentro do prefixo de `STORAGE_S3_BUCKET`, ex.: `planejai/planejai`):

```
banco/                     planejai-AAAAMMDD-HHMM.dump + .json (e antes-de-restaurar-*.dump)
arquivos/documentos/<id>/  documentos de cada pessoa
arquivos/midia/            fotos, áudios, gravações
chaves/                    cofre-das-chaves.json (variáveis da stack cifradas com a senha do dono, scrypt + AES-256-GCM)
LEIA-ME.txt
```

Objetos do formato antigo (`documents/`, `media/`) mudam para `arquivos/` aos poucos na limpeza de hora em hora (copia, troca a chave na linha, apaga o antigo). Dumps que o serviço `backup` da stack deixa em `backups/` vão para `banco/` no backup do app.

**O que está no backup:** todo o Postgres (pessoas, agenda, finanças, memórias, integrações cifradas, configurações, filas, sessão do WhatsApp em `wa_auth`) + os arquivos do bucket. **Fora:** a memória curta do Redis (o resumo das conversas está no banco), o cache e as variáveis da stack (por isso o cofre).

**Restaurar (outra VPS ou a mesma):** suba a stack com os mesmos `STORAGE_S3_*`, `ADMIN_EMAIL` e `ADMIN_PASSWORD`, entre como dono (sem WhatsApp conectado o login não pede código) e use Servidor > Backup > Restaurar. O app baixa o dump, restaura num banco ao lado (`<banco>_restaurando`), roda as migrações, regrava as credenciais com a `ENCRYPTION_KEY` desta stack (se o backup usava outra, pede a senha do cofre ou a chave antiga) e só então troca os nomes: o banco de antes fica como `<banco>_antes_<data>` e, se tinha gente cadastrada, também vai uma cópia para `banco/antes-de-restaurar-*.dump`. App e worker reiniciam sozinhos. Precisa que o usuário do banco crie bancos (o `POSTGRES_USER` da imagem oficial pode).

**Abrir o bucket como pasta:** o B2 não tem FTP; use WinSCP (protocolo Amazon S3) ou Cyberduck com uma Application Key **só leitura** do bucket. Não renomeie nada em `arquivos/`: o banco guarda o caminho.

### Backup local da stack (serviço `backup`)

O serviço `backup` faz um `pg_dump` por dia (formato custom) no volume `planejai_backups` e guarda 14 dias.
O backup tem dados pessoais e a sessão do WhatsApp: guarde a cópia externa num bucket privado.

**Cópia fora do servidor pelo rclone (opcional, o app já manda para o bucket).** Preencha `BACKUP_REMOTE` e as variáveis do rclone no serviço `backup`. Exemplo com Cloudflare R2:

```
BACKUP_REMOTE: r2:planejai-backups
RCLONE_CONFIG_R2_TYPE: s3
RCLONE_CONFIG_R2_PROVIDER: Cloudflare
RCLONE_CONFIG_R2_ACCESS_KEY_ID: ...
RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: ...
RCLONE_CONFIG_R2_ENDPOINT: https://<conta>.r2.cloudflarestorage.com
```

Com Backblaze B2 (mesmo bucket dos arquivos, pasta `backups/`, que o app arruma para `banco/`):

```
BACKUP_REMOTE: b2:<bucket>/<prefixo>/backups
RCLONE_CONFIG_B2_TYPE: s3
RCLONE_CONFIG_B2_PROVIDER: Other
RCLONE_CONFIG_B2_ACCESS_KEY_ID: <keyID da Application Key>
RCLONE_CONFIG_B2_SECRET_ACCESS_KEY: <applicationKey>
RCLONE_CONFIG_B2_ENDPOINT: https://s3.us-east-005.backblazeb2.com
```

No B2 crie uma Application Key só desse bucket (Read and Write), nunca a Master. Com "Keep all versions" o que é apagado vira versão oculta e continua cobrando: ponha a regra de ciclo de vida "Keep prior versions for this number of days" (ex.: 30).

**Conferir:** os logs do serviço `backup` mostram `backup ok: /backups/planejai-AAAAMMDD-HHMM.dump`.

**Restaurar à mão (sem o painel):**

```sh
# 1. pare app e worker (Portainer > serviço > scale 0)
# 2. no container do backup:
pg_restore --clean --if-exists --no-owner -d planejai /backups/planejai-AAAAMMDD-HHMM.dump
# 3. volte app e worker para 1 réplica
```

## Arquivos fora do banco (Cloudflare R2)

Sem configuração, documentos e mídias (gravações, prints) ficam no Postgres. Com um bucket S3 compatível (R2, S3, B2) eles vão para lá e o banco guarda só nome, tamanho e a chave.

1. No Cloudflare: R2 > Create bucket (ex.: `planejai-arquivos`, privado). Depois R2 > Manage API tokens > Create token com **Object Read & Write** só nesse bucket.
2. Na stack (app e worker), preencha:

```
STORAGE_S3_ENDPOINT: https://<conta>.r2.cloudflarestorage.com
STORAGE_S3_BUCKET: planejai-arquivos
STORAGE_S3_REGION: auto
STORAGE_S3_ACCESS_KEY_ID: ...
STORAGE_S3_SECRET_ACCESS_KEY: ...
```

No B2 o endpoint é `https://s3.<região>.backblazeb2.com` e `STORAGE_S3_REGION` é a região (ex.: `us-east-005`), não `auto`: a assinatura usa a região.

3. Atualize a stack. Arquivo novo já vai pro bucket (`arquivos/documentos/<pessoa>/<id>` e `arquivos/midia/<id>`). Os antigos saem do banco aos poucos: a limpeza de hora em hora leva até 50 por rodada (log `limpeza de dados antigos`, campo `movedToStorage`).

- Apagar documento, a pessoa (LGPD) ou mídia vencida apaga o objeto também; o que falhar fica em `storage_trash` e sai na rodada seguinte.
- O `pg_dump` não tem os arquivos que estão no bucket: eles já estão lá, e o backup do app confere a cada dia se cada linha tem o objeto.
- Não desligue o storage depois de ligado: arquivo que já está no bucket só é lido de lá.
- **Cópia na VM** (painel > Servidor > Armazenamento, "Guardar cópia na VM", só super admin; padrão ligado): ligado, documento e mídia novos ficam no bucket e também no banco, e o dump diário fica no volume além do `BACKUP_REMOTE`. Desligado, vão só para o bucket: a limpeza de hora em hora tira do banco o que já está no bucket e o serviço `backup` apaga o dump local depois de copiar (precisa da versão nova do serviço `backup`, então atualize a stack). O Postgres, o Redis e a sessão do WhatsApp continuam sempre na VM.
- O tamanho por cliente na tela Servidor continua vindo da coluna `size` de cada linha.

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
- Logs de execução: o texto (inclusive a conversa dos clientes, que o super admin vê inteira) some depois de `LOG_CONTENT_HOURS` (168 h); custo, tempo e modelo ficam por `EXECUTION_RETENTION_DAYS` (7 dias). O custo por pessoa e por dia fica em `usage_daily` (gráfico em Clientes).
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
