# Compras: achar o menor preço

Nenhuma loja brasileira abre API para um app de fora fechar a compra pela pessoa (Mercado Livre, Shopee, Amazon, Magalu: só busca e afiliados), e o robô que entrava na conta da loja e ia até o Pix foi barrado pelas lojas. Em 2026-10-12 o dono pediu para remodelar: Compras virou **busca comparada + link**. A pessoa pede no WhatsApp, a Nina (agente `compras`) busca nas lojas ao mesmo tempo, devolve as melhores ofertas com link e a pessoa compra no app da loja, logada, com o pagamento dela. Dinheiro e login de loja nunca passam por nós.

## Busca (`shopping.ts`)
- `searchOffers(q, { limit, condition, maxCents, web })`: roda em paralelo as lojas conectadas em Integrações (`Promise.allSettled`; loja que falha vai em `failed`), normaliza em `Offer` (preço em **centavos**), tira o que não bate com o pedido (`relevant`: quase todas as palavras da busca no título e nada de capinha/cabo/película quando não pediram acessório), tira link repetido e ordena do mais barato.
  - **Mercado Livre**: reaproveita `mercadolivre_search` (`agent/tools/research.ts`, OAuth do app do DevCenter). `/sites/MLB/search` dá 403 para app não homologado desde 2025, então cai no catálogo (`/products/search` + `/products/:id/items`). Link `mercadolivre.com.br/p/<id>`.
  - **Shopee**: `integrations/shopee.ts`, API de afiliados (GraphQL `open-api.affiliate.shopee.com.br`, assinatura `SHA256(AppId+Timestamp+corpo+Secret)`), `productOfferV2` por relevância. O `offerLink` já sai com a comissão do dono. Integração `shopee` (App ID + Secret), da plataforma: todo cliente usa a do dono.
  - Sem oferta: `web` (padrão `"any"`) cai no `web_search` (`web_answer`/`web` sem preço garantido). `"keys"` só com Tavily/Brave, sem IA (o painel usa esse, porque a rota não passa pelo Tracer). `false`: nada de web (acompanhamento de preço).
- Próximos candidatos (pedem conta do dono): Lomadee (várias lojas numa API, `x-api-key`), Amazon Creators API (substituiu a PA-API 5; exige conta de afiliado com vendas).

## Lista e aviso de preço
- Tabela `shopping_items` (`db/migrations/050_compras_busca.sql`): título, loja, `cents`, link, foto, `query`, `bought_at`, `watch_id`.
- O aviso de preço é um acompanhamento (`watches.ts`, kind `price`, `notify_mode` `changes`, 30 dias) ligado ao item por `setItemAlert`; meta em centavos vira `target` em reais no watch. Comprou ou tirou da lista: o watch é cancelado. `checkPrice` dos acompanhamentos usa `searchOffers` (Mercado Livre + Shopee, sem web).

## Agente e ferramentas (`agent/tools/shopping.ts`)
`shop_search` (5 ofertas, preço já formatado e em centavos; cache de 30 min em `agent/cache.ts`), `shop_save` (com `alert`/`alert_below`), `shop_list`, `shop_update` (bought, alert, remove). A Nina tem só essas mais `web_search` e `fetch_url`: nada de navegador. O Pesquisador usa `shop_search` no lugar de `mercadolivre_search`.

## Painel (`pages/Compras.tsx`, `styles/compras.css`, prefixo `shop-`)
Em "Meu dia" para todo mundo. Busca com filtro Novos/Usados e teto em R$, ofertas em grade (no celular viram linha com foto pequena), "Abrir na loja" e "Guardar"; "Sua lista" com preço guardado, preço de hoje do acompanhamento, sino do aviso (modal com meta), Comprei e Tirar. Fotos só dos CDNs `*.mlstatic.com` e `*.susercontent.com` (liberados no `img-src` da CSP em `api/security.ts`). Rotas (`api/routes/dashboard/shopping.ts`): `GET /api/compras`, `GET /api/compras/busca?q=&condition=&max=` (40 por hora por pessoa), `POST /api/compras/lista`, `PATCH|DELETE /api/compras/lista/:id`.

## O que saiu
Checkout pelo navegador, Pix da loja, login e cookies de loja, endereço, termos de compra, "Testar lojas", limites em Configurações e a fila `purchases.check` (o worker tira o agendamento antigo). As tabelas antigas (`purchases`, `buyer_profiles`, `user_stores`, `store_sessions`, `store_logins`) ficaram no banco sem uso; apagar os logins guardados só com o sim do dono, numa migração nova.

## Não testado de verdade
APIs do Mercado Livre e da Shopee de verdade (o sandbox não alcança). Teste com a busca do painel depois de colar as chaves da Shopee.
