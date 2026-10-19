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
