# Qual modelo usar

Duas coisas diferentes: o modelo do **Claude** que programa aqui e os modelos dos **agentes do app** (OpenRouter).

## Para quem programa (Claude Code)

Use o apelido (`haiku`, `sonnet`, `opus`) no parâmetro `model` do subagente, não um id fixo: o apelido acompanha a versão mais nova.

| Tarefa | Modelo / subagente | Esforço |
| --- | --- | --- |
| Achar onde algo está, varrer muitos arquivos, responder "onde fica X" | Faça você mesmo com `rg` (tabela "Onde procurar" do `SKILL.md`); se for varredura grande, subagente `Explore` com `haiku` | baixo |
| Texto para o usuário, CSS, um campo, ajuste de tela, teste novo de algo simples | `sonnet` (ou a própria sessão) | baixo/médio |
| Ferramenta nova, rota nova, tela nova | a própria sessão; `sonnet` se for delegar | médio |
| Dinheiro, `requireConfirmation`, permissões/quem vê o quê, segurança, `net.ts`, migração, `orchestrator.ts`/`runner.ts`/`collab.ts`/`guard.ts`, Baileys | `opus` | alto; rode os e2e antes do push |
| Plano de mudança grande, várias áreas | subagente `Plan` com `opus` antes de escrever código | alto |
| Revisar o próprio diff antes do push | skill `code-review` (ou `security-review` quando toca segurança) | médio |

Subagentes começam sem contexto: o pedido leva o objetivo, os arquivos, as regras do `CLAUDE.md` que importam para a tarefa e o que devolver. Use só para trabalho independente (ex.: varrer o painel enquanto você mexe no servidor), um assunto e arquivos diferentes para cada um; quem junta, testa e faz o push é a sessão principal (`paralelo.md`). Pergunta curta não vale um subagente.

## Agentes do app (OpenRouter)

- A fonte da verdade é `ROUTE_DEFAULTS` em `apps/server/src/llm/router.ts`: cada rota (`agent:<id>`, `vision`, `transcription`, `summary`, `improve`, `proactive`, `web_search`, `image`...) tem `model`, `fallbacks`, `maxTokens` e o `why` da escolha. Para ver o que está valendo: `rg -n "task:|model:|maxTokens" apps/server/src/llm/router.ts`. Não copie a lista de modelos para cá: ela muda.
- Em produção o dono troca pela tela **Modelos** (grava em `model_routes`, sem redeploy). `resolveModel(task)` usa o que está no banco e cai no padrão.
- Critério: o mais barato que dá conta. Entrada barata para quem lê muito histórico (CTO, Pesquisador), saída barata para quem escreve muito, modelo omni para áudio, tool-calling confiável para quem mexe em datas e dinheiro (Agenda, Financeiro), e sempre `fallbacks` de outro provedor.
- Confira IDs e preços no catálogo ao vivo (`GET /api/models/catalog`, ou a tela Modelos). Do sandbox o OpenRouter é bloqueado; não invente id: use um que já está no `router.ts` ou peça ao dono para conferir no catálogo.
- Token: o prompt do CTO não repete o que a descrição da ferramenta já diz (e vice-versa); `ask_*` leva só nome + papel. `reasoning: { effort: "low" }` vai em toda chamada.
- Teto apertado: passo cortado pelo `maxTokens` grava `finish_reason: "length"` na saída do passo. `SELECT count(*) FROM execution_steps WHERE output->>'finish_reason' = 'length'` mostra se precisa subir.
- Custo real de cada execução vem do `usage.cost` do OpenRouter e soma em `usage_daily` (tela Clientes). Troca de modelo boa = mesmo resultado nas Execuções com custo menor.
- Custo da plataforma por dia (inclui blog, status, esteira, sem pessoa) soma em `cost_daily` (Tracer); o "no mês" do Painel sai dela porque as execuções são apagadas após `EXECUTION_RETENTION_DAYS`. Gasto e saldo reais vêm de `llm/balance.ts` (`/credits` e `/key` do OpenRouter, cache 60 s) em `/api/overview.openrouterAccount`, só super admin. Voz (TTS) tem custo estimado pelo catálogo, não real.
- Especialista novo ganha rota própria `agent:<id>`; agentes criados para um cliente usam `agent:cliente`.

## Conversas de referência (IA de verdade)
- `apps/server/eval/agentes.eval.ts` (`CASES`): mensagens comuns (gasto curto, lembrete, alarme, memória, meta, mensagem só com o sim, texto de fora pedindo envio) com as ferramentas que o time tem que chamar e o que tem que estar no banco. Roda contra o OpenRouter de verdade com as rotas padrão (`ROUTE_DEFAULTS`), não as da tela Modelos.
- No GitHub: `.github/workflows/eval-agentes.yml`, todo dia às 7h (Brasília) e à mão (Actions > Conversas de referência > Run workflow). Precisa do segredo `OPENROUTER_API_KEY` no repositório; sem ele, não roda. O resumo (tabela por mensagem, se a trava do "fiz" disparou e o custo) sai na página da execução.
- Local: `EVAL_OPENROUTER_API_KEY=... TEST_DATABASE_URL=... REDIS_URL=... npm run eval -w apps/server` (`EVAL_OPENROUTER_BASE_URL` aponta para outro servidor). Mexeu em prompt, modelo, grupo de ferramentas ou trava: rode antes e depois.
