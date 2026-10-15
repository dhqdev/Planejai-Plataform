# Esteira de desenvolvimento (só o dono)

Tela **Esteira** (menu Plataforma, só aparece para o dono da stack; `me.owner`). Um chamado escrito no painel vira PR sozinho:

`fila → entendendo → planejando → codando → revisando → abrindo_pr → testando (→ corrigindo → testando) → pronto`

Cada coluna do quadro é um agente com rota própria em Modelos (`AGENTS` em `devpipeline/pipeline.ts`): **Lia** analista (`dev:refine`, etapa entendendo), **Beto** arquiteto (`dev:plan`, planejando, e responde dúvida do Caio uma vez), **Caio** desenvolvedor (`dev:code`, codando e corrigindo), **Vera** revisora (`dev:review`) e **Tito** testes (`dev:qa`, abre o PR, espera o CI e explica a falha ao Caio). Eles se passam recados curtos (`dev_ticket_steps.kind = 'msg'`, `agent` → `to_agent`, "dono" = você), que aparecem como "Conversa do time" no card e o último no quadro; cada agente lê os recados que recebeu (`inbox`).

Paradas: `precisa_de_voce` (o analista só pergunta se não dá para seguir; a resposta do dono entra no pedido e recomeça), `falhou` ("Tentar de novo" volta para `failed_stage`) e `cancelado`.

## Onde está
- Código: `apps/server/src/devpipeline/pipeline.ts` (etapas, custos, painel), `devpipeline/github.ts` (API REST do GitHub, host fixo), `devpipeline/edits.ts` (JSON do modelo, trocas de trecho, caminhos proibidos, trecho do log do CI).
- Fila `dev.pipeline` (`QUEUES.dev`), consumida na parte do canal do worker: um job por etapa; a espera do CI volta para a fila a cada 60 s (até 45 min; sem CI em 10 min = pronto com aviso).
- Rotas `/api/dev/*` em `api/routes/dashboard/devpipeline.ts` com `requireOwner` (403 até para outro super admin). Tabelas `dev_tickets` e `dev_ticket_steps` (migrações 062 e 063).
- Tela: `apps/dashboard/src/pages/Esteira.tsx` (Chamados e Custos, abas irmãs), estilo em `styles/esteira.css`.
- Teste: `apps/server/test/esteira.e2e.test.ts` (GitHub falso em memória, modelo simulado, fluxo inteiro com CI vermelho e conserto).

## Regras
- Credenciais (`devConfig`): token da integração **Esteira de desenvolvimento** (`esteira`, em `OWNER_INTEGRATIONS`) ou, sem ela, o do GitHub do dono (Integrações > GitHub). Repositório, branch base e limite de custo (padrão US$ 2): da integração da esteira, senão o salvo na própria tela (`settings` chave `dev_pipeline`, `PUT /api/dev/settings`), senão o repositório padrão do GitHub. `devStatus` confere no GitHub se o token escreve (Contents e Pull requests: Read and write) e lê o CI (Actions: Read-only), e a tela mostra o que falta.
- A esteira só escreve em branches `esteira/<id>-<título>`, abre PR em **rascunho**, tira do rascunho quando o CI fica verde e comenta o custo. Nunca mescla nem escreve no branch base.
- Não mexe em `.github/`, `.env`, `package-lock.json` nem em migração existente (`pathProblem`). Trocas são `search/replace` que precisam casar uma vez; erro volta ao modelo uma vez.
- Até 1 volta do revisor e 2 consertos de CI; depois para em `falhou` com o log.
- Modelos nas rotas `dev:refine`, `dev:plan`, `dev:code`, `dev:review` e `dev:qa`, trocáveis em Modelos. Toda chamada aparece em Execuções (gatilho `esteira`, sem cobrar grão) e soma em `dev_ticket_steps`, que alimenta Custos (por etapa, modelo, dia e chamado) e não some com a limpeza do log.
