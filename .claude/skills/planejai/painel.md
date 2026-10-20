# Painel de Controle e Gestão de Contas

## Impersonação de Clientes ("Entrar como")
- **Quem pode:** Somente super admin (dono da stack).
- **Como funciona:** Na ficha do cliente (Pessoas > Clientes, aba Resumo), o botão "Entrar como" chama `POST /api/clients/:id/impersonate`. O cookie de sessão original (`pj_session`) é mantido intacto e um cookie adicional `pj_impersonate` é gravado com o ID da conta do cliente.
- **Sessão:** A função `sessionAccount` em `api/server.ts` verifica se a conta real é super admin e possui o cookie `pj_impersonate`, assumindo o escopo e dados da conta do cliente sem necessitar de senha.
- **Volta:** Uma faixa fixa avisa que a sessão está impersonada. Clicar em 'Voltar para minha conta' chama `POST /api/auth/stop-impersonate`, removendo o cookie `pj_impersonate` e restaurando a sessão do dono.
- **Auditoria:** Toda impersonação é registrada na tabela `impersonations` (`owner_account_id`, `target_user_id`, `target_account_id`, `created_at`).

## Ficha do cliente (Pessoas > Clientes)
- `pages/ClientSheet.tsx` + `styles/pessoas.css`: modal em abas Resumo, Uso, Plano e Perfil; topo fixo e só a aba rola. No celular vira folha de tela cheia com as abas dividindo a largura.
- Dados: `GET /api/clients/:id/usage?days=7|14|30|90` junta `client-overview.ts` (`clientBilling` sem criar carteira, `clientDaily` de `usage_daily` + grãos do extrato, `clientActivity`, `clientFeatures` só com contagens) ao detalhe de agentes/ferramentas (execuções, só 7 dias). Cobranças do Asaas em `GET /api/clients/:id/payments`.
- Aba Plano tem "Dar grãos" e "Liberar sem cobrança" (mesmas rotas de Configurações > Grãos).

## Teclado do celular (teclado.ts)
- `installKeyboardWatch()` (main.tsx) publica no `<html>` `--vvh`/`--vvtop` (área visível de verdade), a classe `pj-kb` com o teclado aberto (some a barra de abas) e zera `--sab` (folga do risco do iPhone; use `var(--sab)` em vez de `env(safe-area-inset-bottom)` em caixa presa embaixo). O campo com foco rola para dentro da sua lista.
- Tela com caixa de escrever presa embaixo chama `useKeyboardShell()` e usa `top: var(--vvtop); height: var(--vvh)`: encolhe até o teclado, topo fica no lugar. Hoje: Recados (conversa), chat do Início, compromisso da Agenda (`EventScreen`). Folhas (`Modal`) já medem sozinhas.
- Hook nunca depois de `return` de carregamento (derrubava Recados com erro 310).
- Faixa amarela de impersonação (`ImpersonateBanner` em App.tsx, `styles/impersonacao.css`): no celular gruda no topo em toda tela; nas de tela cheia (`html.pj-shell`) fica presa e a tela desce `--imp-h`, com `--safe-top` zerado. Topo de tela cheia usa `var(--safe-top)`, não `env(safe-area-inset-top)`.
- Chat do Início: tocar na caixa lendo mensagens antigas não desce para o fim (`keepPlace` segura a distância do fim enquanto o teclado abre ou fecha). No celular o canto direito do topo é o botão de convite (`InviteForm`), não o sino.

## Puxar para atualizar (celular/PWA)
- `PullToRefresh.tsx` no `.main` (vale para toda tela do layout): com a tela no topo, o Bolinho desce com o dedo e um anel roxo (`--act`) se fecha em volta dele conforme o puxão (`TRIGGER` 64px, borracha em `resist`); fechou, ele sorri e vibra; soltou, o anel corre enquanto `refreshAll()` + `checkForUpdate()` rodam e termina fechado. Posição e anel mexidos direto no DOM (sem re-render por quadro). Não pega em `.modal`, folhas, campos de texto, lista com rolagem própria já descida nem em `[data-no-ptr]` (lista do chat do Início). CSS em `styles/avisos.css`.

## Chat do Início (celular e notebook)
- `pages/HomeChat.tsx` (rota `/api/chat`, tabela `app_chat`): no celular é o Início; no notebook abre por `/?chat=1` (botão "Conversar" do painel, prop `wide`, coluna centralizada dentro da moldura).
- Cada fala de agente vem num cartão com o nome dele; o time conversando entre si vira cartões quadrados, dois por linha.
- Cartões de widget (`pages/ChatCards.tsx`, `styles/chat-cartoes.css`): calendário do mês quando a rodada rodou ferramenta de agenda, mini painel (total do mês, comparação, limite, categorias, 7 dias) quando rodou ferramenta de dinheiro. O servidor monta do banco depois da resposta (`chat-cards.ts`, coluna `app_chat.cards`), sem texto nem token do modelo, só se a ferramenta teve sucesso; os atalhos sem IA (gasto do mês, agenda de hoje/amanhã) também ganham o cartão. Novo tipo de cartão: `cardKinds`/`buildCards` no servidor e `ChatCard` na tela.

## Tempo real e abertura do app
- Tabelas do painel têm o gatilho `pj_live` (migração `apps/server/src/db/migrations/077_tempo_real.sql`): toda mudança, venha do worker, do n8n ou da API, faz `pg_notify('pj_live', '<tabela>:<user_id>')`. `apps/server/src/live.ts` escuta e manda por SSE (`GET /api/live`) só o nome da tabela para quem pode ver (super admin tudo; os outros a própria pessoa e quem compartilhou tela). Nunca vai dado no aviso.
- No painel, `apps/dashboard/src/live.ts` abre uma conexão só (fecha com o app em segundo plano por 1 min). `useApi(path, { poll, live: ["tabela"] })` recarrega na hora quando a tabela muda; com o tempo real ligado o `poll` vira só segurança (no mínimo 1 min), sem ele volta ao intervalo normal. Tela nova que mostra dado de uma tabela: passe `live`. Tabela nova que aparece no painel: crie o gatilho numa migração nova (`pj_live_user()` se tem `user_id`, `pj_live_any()` se é só do dono).
- Abertura: o `index.html` pede `/api/auth/me` antes do JS chegar (`window.__pjMe`, usado por `bootMe` no `App.tsx`) e o código da tela aberta começa a baixar junto. Login, termos (`Privacy`) e a primeira conversa (`Onboarding`) são pedaços à parte.

## Troca de tela (transição)
- `transicao.ts` cria o histórico do roteador (`HistoryRouter` no `main.tsx`, mesmo peso do BrowserRouter) e roda cada troca de caminho dentro de `document.startViewTransition`, incluindo o voltar do navegador; espera o `App` desenhar a tela nova (`screenDrawn`, no máximo 1,5 s). Fora: só `?`/`#`, `replace` e "reduzir movimento".
- A tela antiga sai enquanto a nova entra (sem quadro vazio; o código da tela nova carrega com a antiga parada). `styles/transicao.css`: `.main` e `.tabbar` ganham foto própria só enquanto roda (`html.pj-vt`, nome fixo faria janelas de dentro do `.main` caírem atrás da barra); o jeito vem de `<html data-nav>` (push/pop/tab, `useRouteMotion` no `App.tsx`). Celular desliza no jeito do iOS; notebook esmaece e sobe 8px.
- Navegador sem a API cai nas animações `.route-push/.route-pop/.route-tab` da tela nova. A troca de tema usa `html.pj-theme-vt` (tela inteira numa foto só para o círculo).
