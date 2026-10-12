# Compras: achar o menor preço

Nenhuma loja brasileira abre API para um app de fora fechar a compra pela pessoa (Mercado Livre, Shopee, Amazon, Magalu: só busca e afiliados), e o robô que entrava na conta da loja e ia até o Pix foi barrado pelas lojas. Em 2026-10-12 o dono pediu para remodelar: Compras virou **busca comparada + link**. A pessoa pede no WhatsApp, a Nina (agente `compras`) busca nas lojas ao mesmo tempo, devolve as melhores ofertas com link e a pessoa compra no app da loja, logada, com o pagamento dela. Dinheiro e login de loja nunca passam por nós.

## Busca (`shopping.ts`)
- `searchOffers(q, { limit, condition, maxCents, web })`: roda em paralelo as lojas conectadas em Integrações (`Promise.allSettled`; loja que falha vai em `failed`), normaliza em `Offer` (preço em **centavos**), tira o que não bate com o pedido (`relevant`: quase todas as palavras da busca no título e nada de capinha/cabo/película quando não pediram acessório), tira link repetido e ordena do mais barato.
  - **Mercado Livre**: reaproveita `mercadolivre_search` (`agent/tools/research.ts`, OAuth do app do DevCenter). `/sites/MLB/search` dá 403 para app não homologado desde 2025, então cai no catálogo (`/products/search` + `/products/:id/items`). Link `mercadolivre.com.br/p/<id>`.
  - **Shopee**: `integrations/shopee.ts`, API de afiliados (GraphQL `open-api.affiliate.shopee.com.br`, assinatura `SHA256(AppId+Timestamp+corpo+Secret)`), `productOfferV2` por relevância. O `offerLink` já sai com a comissão do dono. Integração `shopee` (App ID + Secret), da plataforma: todo cliente usa a do dono.
  - Sem oferta: `web` (padrão `"any"`) cai no `web_search` (`web_answer`/`web` sem preço garantido). `"keys"` só com Tavily/Brave, sem IA (o painel usa esse, porque a rota não passa pelo Tracer). `false`: nada de web (acompanhamento de preço).
- **Variação certa** (`variants.ts`, só texto, sem rede): `variant` ("42, preto", "220V", "128 GB") + o que já vem no pedido (`parseQuery`).
  - `variantQuestions(query, variant)`: calçado e roupa pedem tamanho, eletro pede voltagem, celular/SSD/pendrive pede memória (capinha não). `shop_search` volta `ask_first` sem buscar; "tanto faz" libera (`anyVariant`). O painel busca mesmo assim e mostra a dica (`ask`).
  - `conflicts`: tira anúncio que diz outra voltagem ou memória no título (bivolt serve para qualquer voltagem). Memória entra no texto da busca (no catálogo cada capacidade é outro produto); tamanho, cor e voltagem não.
  - Mercado Livre: `resolveMercadoLivre` pega as 4 mais baratas com link `/p/<id>`, lê `/products/<id>` e anda pelos `pickers` (Cor, Tamanho, Voltagem, Memória; `pickerDim`/`optionFits`) até bater tudo; trocou de produto, pega o menor preço de `/products/<id>/items` (respeitando Novos/Usados). Seletor sem a opção pedida = a loja não vende nessa variação, a oferta sai. Bateu tudo: `variant_ok`. Sobrou algo: `pick` ("tamanho 42"), que a pessoa escolhe na página.
  - Shopee (a API de afiliados não expõe variações) e anúncio comum do Mercado Livre: só `pick`.
- Preço suspeito: com 4 ofertas ou mais, sai o que custa menos de 30% da mediana (golpe, peça avulsa). `mercadolivreApi` e o OAuth têm timeout de 12 s.
- Próximos candidatos (pedem conta do dono): Lomadee (várias lojas numa API, `x-api-key`), Amazon Creators API (substituiu a PA-API 5; exige conta de afiliado com vendas).

## Lista e aviso de preço
- Tabela `shopping_items` (`db/migrations/050_compras_busca.sql`): título, loja, `cents`, link, foto, `query`, `variant` (052), `bought_at`, `watch_id`.
- O aviso de preço é um acompanhamento (`watches.ts`, kind `price`, `notify_mode` `changes`, 30 dias) ligado ao item por `setItemAlert`; meta em centavos vira `target` em reais no watch. Comprou ou tirou da lista: o watch é cancelado. `checkPrice` dos acompanhamentos usa `searchOffers` (Mercado Livre + Shopee, sem web) com a `variant` do watch (`watches.variant`, 052), então o preço vigiado é o da variação certa.

## Agente e ferramentas (`agent/tools/shopping.ts`)
`shop_search` (5 ofertas, preço já formatado e em centavos, `variant`, `ask_first`, `variant_ok`, `pick` "Na loja, escolha: …"; cache de 30 min em `agent/cache.ts`), `shop_save` (com `variant`, `alert`/`alert_below`), `shop_list`, `shop_update` (bought, alert, remove; `bought` devolve `finance_offer` e o CTO pergunta se lança o gasto em Finanças, categoria Compras, pelo Financeiro). Plano das fases seguintes (carteira com token de pagamento quando Mastercard Agent Pay/Visa abrirem no Brasil): doc "Compras com agente: plano" (https://claude.ai/code/artifact/1a087e1f-7193-4466-a337-19dd933cf3ca). A Nina tem só essas mais `web_search` e `fetch_url`: nada de navegador. O Pesquisador usa `shop_search` no lugar de `mercadolivre_search`.

## Painel (`pages/Compras.tsx`, `styles/compras.css`, prefixo `shop-`)
Em "Meu dia" para todo mundo. Busca com campo "Cor, tamanho, voltagem", filtro Novos/Usados e teto em R$, ofertas em grade (no celular viram linha com foto pequena), selo "Variação certa" ou a linha "Na loja, escolha: …", "Abrir na loja" e "Guardar" (guarda com a variação); "Sua lista" com preço guardado, preço de hoje do acompanhamento, sino do aviso (modal com meta), Comprei e Tirar. Fotos só dos CDNs `*.mlstatic.com` e `*.susercontent.com` (liberados no `img-src` da CSP em `api/security.ts`). Rotas (`api/routes/dashboard/shopping.ts`): `GET /api/compras`, `GET /api/compras/busca?q=&condition=&max=&variant=` (40 por hora por pessoa), `POST /api/compras/lista`, `PATCH|DELETE /api/compras/lista/:id`.

## O que saiu
Checkout pelo navegador, Pix da loja, login e cookies de loja, endereço, termos de compra, "Testar lojas", limites em Configurações e a fila `purchases.check` (o worker tira o agendamento antigo). Os logins guardados das lojas (`store_sessions`, `store_logins`) foram apagados a pedido do dono (`db/migrations/051_sem_login_de_loja.sql`); `purchases`, `buyer_profiles` e `user_stores` ficaram no banco sem uso.

## Não testado de verdade
APIs do Mercado Livre e da Shopee de verdade (o sandbox não alcança). Teste com a busca do painel depois de colar as chaves da Shopee.
