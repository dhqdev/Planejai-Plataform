# Compras pelo assistente

A pessoa pede no WhatsApp ("compra pra mim um fone JBL no Mercado Livre") e o agente Compras (Nina) vai até o Pix do checkout da loja, com a conta da própria pessoa. Só **Pix direto**: depois do "sim", o servidor manda o código Pix da loja numa mensagem sozinha (para copiar) e a pessoa paga do banco dela. Dinheiro nunca passa por nós, sem taxa. Cartão e saldo foram tirados em 2026-10-09 (migração `db/migrations/035_compras_so_pix.sql`), a pedido do dono. Desligado por padrão: o dono liga e ajusta os limites em Configurações > Compras. Explicação animada para o dono e para o cliente em `ComoFuncionaCompras.tsx` (tela `pages/Compras.tsx`).

## Fluxo (`purchases.ts`)
- `purchase_info` (`agent/tools/purchases.ts`): lojas conectadas, endereço, limites e se aceitou os termos.
- `purchase_start` recebe o Pix copia e cola inteiro. `preparePurchase` lê o valor (`checkStorePix`), confere regras e grava `awaiting_confirm`; a ferramenta chama `requireConfirmation` com o resumo do servidor. No "sim", roda de novo com `approvedAction` e `approvePurchase` confere as regras outra vez; só uma execução passa (UPDATE condicional) e vira `awaiting_person` com o código enviado por `tellPerson`.
- A pessoa avisa que pagou (agente usa `purchase_update`, ou o botão "Já paguei" na tela): `paid`, depois `delivered`. Também `canceled`.
- Rodada a cada 2 minutos (`checkOpenPurchases`, fila `purchases.check`): pedido sem "sim" em 30 minutos e Pix não pago em 2 dias são cancelados, com aviso.

## Regras que não podem quebrar
- O valor nunca vem do modelo: sai do código Pix (`pixcode.ts` confere CRC e campo 54). Pix dinâmico sem valor escrito é lido no Asaas (`POST /pix/qrCodes/decode`, só leitura); sem Asaas conectado, recusa.
- Limites do dono por compra (`purchaseMaxCents`) e em 30 dias (`purchaseMonthMaxCents`, `spentLast30`).
- Sem termos aceitos (`TERMS_VERSION`) nada sai.

## Login na loja (`storelogin.ts`)
A pessoa entra na conta dela numa janela ao vivo do painel: o servidor abre o navegador (`BrowserSession`), o painel mostra prints e manda cliques e texto (`/api/compras/login/:id`). Senha e código não passam pelo modelo. No "Pronto, entrei" guardamos só os cookies da loja, criptografados (`store_sessions`). A janela não sai do site da loja. O `browser_open` carrega os cookies da loja da URL e, no `browser_close`, guarda os renovados. O agente de compras tem 35 ações no navegador (`MAX_SHOP_ACTIONS`); a página volta com `pix_codes` quando acha um Pix.

## Dados e termos
- `buyer_profiles`: só o endereço de entrega, criptografado (`encryptJson`), e o aceite dos termos. Endereço é opcional: sem ele o agente usa o endereço da conta da loja. Pedido no fim das perguntas de boas-vindas (`pages/Welcome.tsx`, opcional) e em Compras (`AddressForm`).
- Termos em `/termos-de-compra` (`pages/PurchaseTerms.tsx`). Mudou algo importante: suba `TERMS_VERSION` e todo mundo aceita de novo. Privacidade (`pages/Privacy.tsx`) cita o endereço, os cookies da loja e a leitura do Pix no Asaas.
- Migrações `db/migrations/034_compras.sql` e `db/migrations/035_compras_so_pix.sql`. Testes em `test/purchases.e2e.test.ts`.

## Não testado de verdade
O decode do Asaas real e o login nas lojas pelo Browserless: o sandbox de desenvolvimento não alcança essas URLs. Teste primeiro com uma conta sua no Mercado Livre.
