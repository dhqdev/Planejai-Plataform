# Rodar, testar e publicar

Leia antes de mexer em CI, Dockerfile, stacks, migrações ou para rodar localmente.

## Rodar e testar

```bash
npm ci
cp .env.example .env            # preencha SESSION_SECRET, ENCRYPTION_KEY, ADMIN_PASSWORD, OPENROUTER_API_KEY, DATABASE_URL
docker compose up db redis -d   # ou Postgres/Redis locais
npm run dev                     # API + worker em :3000 (migra no boot)
npm run dev:dashboard           # dashboard em :5173 com proxy para :3000
npm run typecheck && npm run lint && npm test   # e2e rodam com TEST_DATABASE_URL (banco descartável); REDIS_URL e CHROME_PATH ligam os testes de Redis e navegador
npm run build                   # dashboard vai para apps/server/public
```
Sem WhatsApp, teste pelos e2e (canal playground) e veja os passos em **Execuções**. No sandbox da nuvem, Postgres e Redis já estão instalados: receita em `paralelo.md` ("Testes no sandbox"). Ordem de pull, checagens e push com outras sessões no main: também em `paralelo.md`.

## Publicar
- Push na `main` roda `.github/workflows/ci.yml`: o job `image` só sai depois do `test` verde e publica `ghcr.io/dhqdev/planejai-plataform` (amd64 e arm64) com as tags `latest` e `sha-<curto>`, depois chama o webhook do Portainer (`PORTAINER_WEBHOOK_URL`). Rollback = trocar a tag na stack para um `sha-…` antigo. Push que só muda `.claude/`, `docs/` ou `.md` não roda o CI. Imagem privada: o Portainer puxa com token `read:packages` (`docs/operacao.md`). Não recrie um workflow de deploy separado do teste.
- Operação (segredos, backup/restore, rollback, saúde, plano do número): `docs/operacao.md`.
- Versões: **cada push na main** que passa no CI vira uma patch nova (job `image` do `ci.yml`: próxima patch depois da maior entre package.json e a última tag, tag `vX.Y.Z` + release com os commits, imagem `X.Y.Z`/`X.Y`/`latest`, `APP_VERSION` no build do painel e do servidor). O workflow **Release** (manual: patch/minor/major/atual) fica para subir minor/major sobe os `package.json`, escreve `CHANGELOG.md`, cria tag `vX.Y.Z` + release e dispara o CI na tag (imagem `X.Y.Z`, `X.Y`, `latest`). A versão vem do package.json (`src/version.ts`, `APP_VERSION`/`GIT_SHA` no build) e aparece no painel e no `/health`. Não edite a versão à mão.
- Stacks: `redis` guarda memória curta (appendonly, noeviction) e `redis-cache` (`REDIS_CACHE_URL`, allkeys-lru) guarda cache; `backup` faz `pg_dump` diário em `planejai_backups` (14 dias, `BACKUP_REMOTE` opcional via rclone); browserless fica fixo numa versão e na rede `planejai_browser`. Imagem de terceiros sempre com versão fixa.
- Healthcheck da imagem: `node apps/server/dist/healthcheck.js` (API olha `/health`; worker olha o arquivo de vida de `alive.ts` e, se tiver o aluguel do WhatsApp, o `heartbeat_at`).
- Stack: `deploy/portainer-stack.yml` (compose comum) ou `deploy/swarm-traefik-stack.yml` (Swarm + Traefik em network_public, domínio autoplanejai.tekvosoft.com). Postgres e Redis são da própria stack; nunca aponte para os que já existem no servidor.
- O Dockerfile só roda `apk add ffmpeg` na arquitetura alvo; o resto das deps é JS puro. Não adicione dependência nativa no servidor sem ajustar isso.

## Banco
Nova migração = novo arquivo `db/migrations/0NN_descricao.sql` (nunca edite uma já aplicada). Roda sozinha no boot. Número repetido por outra sessão: renomeie a sua antes do push (`paralelo.md`).
