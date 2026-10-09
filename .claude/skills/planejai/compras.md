# Compras pelo assistente

A pessoa pede no WhatsApp ("compra pra mim um fone JBL no Mercado Livre") e o agente Compras (Nina) vai até o Pix do checkout da loja, com a conta da própria pessoa. Tudo desligado por padrão: o dono liga em Configurações > Compras. Explicação animada para o dono e para o cliente em `ComoFuncionaCompras.tsx` (tela `pages/Compras.tsx`).

## Os três jeitos (`purchases.ts`)
- **Pix direto** (`pix`): o servidor manda o código Pix da loja sozinho numa mensagem (para copiar) e a pessoa paga do banco dela. Dinheiro nunca passa por nós, sem taxa. Ela avisa que pagou e o agente marca com `purchase_update`.
- **Cartão** (`card`): cobra o total (loja + taxa) no Asaas. Com token salvo e `remote_ip`, cobra na hora; sem token, manda o link do Asaas (`invoiceUrl`) e o webhook (`handlePurchasePayment`) guarda o token e segue. Aprovado vira `charged` e `payStore` paga o Pix da loja (`POST /pix/qrCodes/pay`). Falhou depois de cobrar: `failPurchase` estorna (`/payments/{id}/refund`).
- **Saldo** (`wallet`): recarga só por Pix (`createTopup`, ref `topup:<id>`). Na compra reserva (`shop_ledger` "reserva"), paga a loja e a reserva vira débito; falhou, "devolucao". Uma entrada por (tipo, ref).

## Regras que não podem quebrar
- O valor nunca vem do modelo: sai do código Pix (`pixcode.ts` confere CRC e campo 54) e do decode do Asaas (`checkStorePix`), conferido de novo em `payStore`. Mudou um centavo, a compra falha e devolve.
- `purchase_start` (`agent/tools/purchases.ts`) prepara a compra (`preparePurchase`, status `awaiting_confirm`) e chama `requireConfirmation` com o resumo do servidor. No "sim", roda de novo com `approvedAction` e `approvePurchase` confere as regras outra vez; só uma execução passa (UPDATE condicional).
- Validação de saque do Asaas: `/webhooks/asaas/saque` (`validateWithdrawal`) aprova só o `PIX_QR_CODE` com `pix_tx_id` de uma compra em `paying_store` e valor exato. O resto é recusado.
- Limites do dono por compra e em 30 dias (`spentLast30`), cartão só para quem pagou plano (`purchaseCardNeedsPlan`), saldo máximo. Taxa (`feeFor`) só no cartão e no saldo.
- Rodada a cada 2 minutos (`checkOpenPurchases`, fila `purchases.check`): Pix da loja pendente, compra cobrada parada e pedidos sem "sim" há 30 minutos.

## Login na loja (`storelogin.ts`)
A pessoa entra na conta dela numa janela ao vivo do painel: o servidor abre o navegador (`BrowserSession`), o painel mostra prints e manda cliques e texto (`/api/compras/login/:id`). Senha e código não passam pelo modelo. No "Pronto, entrei" guardamos só os cookies da loja, criptografados (`store_sessions`). A janela não sai do site da loja. O `browser_open` carrega os cookies da loja da URL e, no `browser_close`, guarda os renovados. O agente de compras tem 35 ações no navegador (`MAX_SHOP_ACTIONS`); a página volta com `pix_codes` quando acha um Pix.

## Dados e termos
- `buyer_profiles`: nome, CPF, nascimento e endereço criptografados (`encryptJson`); na tela só o final do CPF. Cartão: token criptografado, bandeira e final. Pedido no fim das perguntas de boas-vindas (`pages/Welcome.tsx`, opcional) e em Compras.
- Termos em `/termos-de-compra` (`pages/PurchaseTerms.tsx`). Mudou algo importante: suba `TERMS_VERSION` e todo mundo aceita de novo. Privacidade (`pages/Privacy.tsx`) cita o que vai para o Asaas e para a loja.
- Migração `db/migrations/034_compras.sql`. Testes em `test/purchases.e2e.test.ts`.

## Não testado de verdade
Asaas real (decode, pagar Pix, validação de saque) e o login nas lojas pelo Browserless: o sandbox de desenvolvimento não alcança essas URLs. Teste primeiro com a chave de sandbox do Asaas e uma conta sua no Mercado Livre.
