# Várias sessões no main sem travar

Leia antes do primeiro commit da sessão. O dono quer push direto no `main`, sem PR, e várias sessões do Claude (nuvem e notebook) trabalham ao mesmo tempo. Cada push com código roda o CI, publica imagem e atualiza produção.

## Ao começar
- `git fetch origin main && git status -sb && git log --oneline -12 origin/main`. O hook `.claude/hooks/inicio.mjs` faz isso sozinho no início da sessão (Claude Code roda pelo `.claude/settings.json`).
- Veja o que as outras sessões estão mexendo agora: `git log --since="3 hours ago" --name-only --format="--- %h %ar %s" origin/main | head -80`.
- Em Claude Projects, cada thread é dona de um assunto (ex.: uma thread mexe nos agentes, outra no painel). Não edite a área que outra thread está mudando; se precisar, mande o pedido para a dona pelo coordenador ou pela sessão dela.
- Trabalhe a partir do `main` atualizado: `git checkout -B main origin/main` se a cópia local estiver velha e sem trabalho seu pendente.

## Enquanto trabalha
- Commits pequenos, um assunto por commit, mensagem em português. Arquivo da skill atualizado no mesmo commit da mudança de comportamento.
- Não acumule horas de trabalho sem commit: commite local cedo (dá para refazer o rebase) e publique quando os testes passarem.
- Arquivos quentes (muitas sessões tocam): `agent/team.ts`, `agent/prompts.ts`, `llm/router.ts`, `App.tsx`, `styles.css`, `api/routes/dashboard.ts`, `components.tsx`, os `.md` desta skill e `package-lock.json`. Mexa só nas linhas do seu assunto, sem reformatar o arquivo inteiro nem reordenar imports alheios.
- Migração nova: pegue o número na hora do commit (`ls apps/server/src/db/migrations | tail -3`). Se depois do rebase outro arquivo já usa o mesmo número, renomeie a SUA para o próximo livre (`git mv`). Nunca renomeie nem edite uma que já está no `origin/main`.
- Dependência nova: só se precisar mesmo; JS puro (Dockerfile não tem toolchain nativa).

## Antes do push (sempre nesta ordem)
```bash
git pull --rebase origin main
npm run typecheck && npm run lint && npm test     # e2e: ver "Testes no sandbox" abaixo
git push origin HEAD:main
```
- Push recusado (alguém publicou antes): `git pull --rebase origin main` de novo e rode `npm run typecheck` (rápido). Rode o `npm test` de novo só se o rebase trouxe código da sua área. Repita até entrar; nunca `--force` no main.
- Push que só muda `.claude/`, `docs/` ou `.md` não roda o CI; dá para publicar só com a checagem do teste da skill (`npx vitest run test/skills.test.ts` em `apps/server`).

## Conflito no rebase
- Num rebase, `--ours` é o `origin/main` (o que os outros publicaram) e `--theirs` é o SEU commit.
- Mantenha as duas mudanças sempre que possível. Se as duas mexeram na mesma lógica, fique com a versão publicada e reaplique a sua intenção por cima.
- `package-lock.json`: `git checkout --ours package-lock.json && npm install && git add package-lock.json`. Nunca edite o lock à mão.
- Continue sem abrir editor: `GIT_EDITOR=true git rebase --continue`.
- Antes de qualquer coisa drástica, guarde seu trabalho: `git branch salvo/<assunto>`. Nunca `git reset --hard origin/main` com commit seu não publicado sem esse backup. Nunca apague nem desfaça commit de outra sessão.
- Não entendeu o conflito depois de ler as duas versões e o `git log -p` do trecho? Pare, mantenha o backup e pergunte ao dono (ou à thread dona do assunto) em uma linha.

## CI
- O CI cancela a rodada anterior quando chega push novo (`concurrency` em `ci.yml`). "Cancelado" no seu commit é normal: o que vale é a rodada do commit mais novo do main, que já contém o seu.
- Não fique esperando o CI com `sleep` em loop. Publicou e os testes locais passaram: reporte. Se tiver como receber evento do CI, trate quando chegar.
- CI vermelho no main por commit de outra sessão: não reverta o commit dela. Se a quebra está na sua área ou o conserto é óbvio e pequeno, corrija num commit próprio; senão avise o dono em uma linha com o teste que falha.

## Testes no sandbox da nuvem
O contêiner da nuvem tem Postgres 16 e Redis instalados, mas desligados. Para os e2e:
```bash
pg_ctlcluster 16 main start
su postgres -c "psql -c \"create user planejai password 'planejai' superuser;\" -c 'create database planejai_test owner planejai;'"
redis-server --daemonize yes
export TEST_DATABASE_URL=postgres://planejai:planejai@localhost:5432/planejai_test REDIS_URL=redis://localhost:6379
npm test     # ~45 s; teste de navegador liga com CHROME_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
```
OpenRouter e web.whatsapp.com são bloqueados no sandbox: LLM e pareamento só se testam com mock e com o canal playground. Não tente contornar o bloqueio; diga o que ficou sem teste ao vivo.

## Como não travar
- Comando longo (teste, build, `npm ci`) com timeout ou em segundo plano. Nada interativo (`git rebase -i`, editor, `npm init`, prompts de senha).
- O mesmo erro duas vezes: pare de repetir. Releia o arquivo da skill do assunto, procure quem mexeu por último (`git log -S "<trecho>"`) e mude de abordagem.
- Ferramenta bloqueada pelo ambiente (rede, permissão): não fique tentando de novo. Faça o que dá sem ela e diga em uma linha o que faltou.
- Dúvida que não muda o resultado: escolha o padrão e diga qual. Pergunta só para o que é sem volta ou muda o que o dono vai ver (`SKILL.md`, "Perguntar ao dono").
- Produção (Portainer, banco de produção, mensagem para gente de verdade, dados de clientes) só com pedido explícito do dono.
- Subagentes: só para trabalho independente de verdade (ver `modelos.md`), cada um num assunto e em arquivos diferentes. Dois agentes nunca editam o mesmo arquivo ao mesmo tempo; quem junta e faz o push é a sessão principal.
