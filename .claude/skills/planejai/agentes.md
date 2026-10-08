# Agentes, memória e ritmo

Leia antes de mexer no orquestrador, no time (CTO, especialistas, agentes sob medida), em prompts, filas, modelos ou no navegador dos agentes.

## Confirmação de ação sensível
- Ação com dinheiro, mensagem para terceiro ou apagar chama `requireConfirmation(args, resumo, ctx)` (`agent/tools/types.ts`). Ela NÃO executa: guarda em `pending_actions` e devolve o resumo para o agente perguntar. Quem libera é a próxima mensagem da pessoa, lida sem IA em `agent/confirm.ts` (`confirmationAnswer`): "sim" executa exatamente o que foi guardado, "não" descarta, outra coisa deixa o pedido cair. O campo `confirmed_by_user` não libera nada.
- Teste chamando a ferramenta direto: passe `{ ...ctx, approvedAction: true }`.
- Nova tentativa da fila (erro passageiro do LLM) só refaz a rodada se nenhuma ferramenta com efeito rodou (`sideEffectsDone` em `orchestrator.ts`). Ferramenta nova só de leitura: confira se o nome cai em `NO_SIDE_EFFECT`.
- O worker processa com `wait: false`: conversa ocupada volta para a fila em 5 s em vez de prender uma vaga.

## Memória curta, retenção e mídia
- Contexto do CTO = últimas `HISTORY_LIMIT` entradas do Redis (texto já interpretado) + resumo da conversa + memórias. Não volte a mandar mídia crua ou documento inteiro para o LLM: documento entra com prévia de 2.500 caracteres e o resto via `read_document`.
- Conversa não é guardada no Postgres quando o Redis está no ar: a mensagem é apagada depois de processada e a resposta não é gravada (o histórico já está no WhatsApp). Sem Redis, cai no modo antigo (guarda `MESSAGE_RETENTION_HOURS` e resume).
- Cache no Redis (`shortmem.ts`: `cacheGet`/`cacheSet`, `markSeen`, `countInWindow`): resultado de web_search/fetch_url (6h) e Mercado Livre (1h), interpretação de mídia por hash (30 dias), texto de documento (24h), dedupe de webhook e ritmo por minuto. Ferramenta nova determinística pode entrar no cache do runner (`agent/cache.ts`).
- Gravações e prints ficam em `media_files` (servidos por `/api/media/:id`) por `EXECUTION_RETENTION_DAYS`.

## Ritmo das respostas (estilo Instinct)
- `agent/progress.ts`: mantém o "digitando..." ligado e manda avisos curtos. A frase que o CTO escreve junto de um `ask_*` sai na hora ("deixa eu ver aqui 🔎"); se ele não escrever nada, um aviso de reserva sai após 7s e outro aos 45s (máx. 3 por execução, sem LLM).
- Resposta junto de `react_to_message`/`save_memory` é entregue sem outra rodada do modelo (pergunta simples = 1 chamada). Não quebre isso ao mexer no runner.
- A primeira coisa de toda execução é a reação temática instantânea (`agent/reaction.ts`, regex, sem IA): cinema 🍿, gasto 💸, viagem ✈️... O CTO não reage de novo; só troca por ✅ quando conclui uma tarefa. Tema novo = linha nova em THEMES (a ordem importa).
- "valeu", "ok", "kkk" ou só emoji (isAckOnly em `agent/reaction.ts`): a reação responde e o CTO nem é chamado. "ok"/"sim" contam como pergunta respondida se a última fala do assistente terminou com "?".
- Todo texto que sai (balões, avisos, notifyUser) passa por `humanize()` (`agent/humanize.ts`): sem "-", "•" ou travessão, para soar como gente. Não reintroduza listas com marcador no prompt.

## Reunião noturna do time e proatividade
- `improve.ts` (fila `improve.daily`, 19h no `DEFAULT_TIMEZONE`): a "reunião" do Téo (CTO) é UMA chamada barata em JSON por pessoa ativa. Ela devolve: `style` (vai para `users.style_notes` e entra no prompt do CTO), `agent_notes` (uma dica por especialista em `agent_notes`, entra no prompt dele via `collab.ts`), `tabs` (libera módulos e no máximo 1 aba nova por noite) e `create` (agente do cliente com `persona`; a carinha sai de `faceFor(userId:slug)`). Assuntos somam em `user_topics` e viram agente (`client_agents`, até 3, ferramentas só de `CLIENT_AGENT_TOOLS`) quando aparecem em 2 dias diferentes. Botão "Reunião agora" em Agentes.
- **Time de cada pessoa** (`agent/tools/team.ts`): o CTO também cria agentes na conversa com `team_create_agent` (com `first_task` o agente novo já trabalha na mesma resposta), ajusta com `team_adjust_agent` (agente sob medida: instruções, foco, ferramentas, aposentar; especialista fixo: grava `agent_notes` só daquela pessoa) e lista com `team_list`. Limite `MAX_CLIENT_AGENTS` (6) por pessoa; `client_agents.origin` diz se nasceu na reunião (`melhoria`) ou a pedido (`pedido`), e a reunião noturna só aposenta os que ela criou. A `TeamRoom` de cada execução recebe o time da pessoa (fixos + sob medida), então agentes sob medida consultam e são consultados (`consult_c_<slug>`) como qualquer colega.
- Uso por cliente (super admin, Clientes > pessoa): `GET /api/clients/:id/usage` traz execuções, custo, mensagens por dia, quem trabalhou (por agente), agentes criados, o que o time aprendeu e as abas (`PUT /api/clients/:id/tabs`).
- `watches.ts` (fila `watch.check`, a cada 15 min): preço (Mercado Livre) e notícias (busca) são conferidos sem LLM. Duram 7 dias por padrão (1 a 30). `notify_mode` "always" (padrão) manda o resultado de cada olhada, achando ou não (texto pronto, sem IA); "changes" só fala quando algo melhora. Quando há novidade, o modelo `proactive` escreve o aviso. No fim do prazo avisa uma vez (`ended_notice`). Tela /watches cria, ajusta (PATCH), pausa, "Olhar já" (POST /api/watches/:id/check) e reativa; no WhatsApp `watch_create`/`watch_update`.
## Navegador (pesquisa gravada)
- Ferramentas do Pesquisador: `browser_open` (record/send_recording), `browser_action`, `browser_screenshot`, `browser_close`. A sessão fica em `ctx.room.browser`; o orquestrador fecha o que ficou aberto e manda a gravação se ela foi pedida.
- Precisa de ffmpeg (já na imagem) e do browserless da stack (`TIMEOUT` 300000). Em dev: `CHROME_PATH=/caminho/do/chrome`.

## Filas (como o modo fila do n8n)
- Tudo passa pelo pg-boss (`queue/boss.ts`): mensagem vira job `conversation.process` (prioridade 10), lembretes, resumos, convites, De olho e reunião noturna têm fila própria com retry. `WORKER_CONCURRENCY` (padrão 4) = jobs em paralelo por réplica do worker; para escalar, aumente isso ou suba réplicas (a conexão do WhatsApp continua em um só processo pelo lock).
- Tela **Filas** (super admin, `GET /api/queues`): na fila, rodando, feitos e falhas em 24h, tempo médio e de espera; falha pode ser reprocessada (`POST /api/queues/:name/:id/retry`).

## Trocar modelos
Padrões em `ROUTE_DEFAULTS` com o porquê de cada escolha e `maxTokens` por rota; em produção troque pela tela **Modelos** (grava em `model_routes`, sem redeploy). Critério: entrada barata para quem lê muito histórico (CTO, Pesquisador), saída barata para quem escreve muito, modelo omni para áudio, e sempre `fallbacks`. Confira IDs e preços no catálogo ao vivo (`GET /api/models/catalog`).
