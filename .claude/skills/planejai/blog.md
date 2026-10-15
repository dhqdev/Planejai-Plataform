# Blog público (/blog)

Blog no jeito de revista (referência visual: blog da Toki), aberto com ou sem login. Conteúdo próprio, nunca copiado.

## Onde fica
- Servidor: `apps/server/src/blog.ts` (redator, ilustrações, agenda semanal, conferência `cleanDraft`), posts de partida em `blog-seed.ts`, rotas públicas e o `<head>` do Google em `api/routes/blog.ts`, painel em `api/routes/dashboard/blog.ts`. Tabelas `blog_posts`, `blog_images` e `blog_image_failures` (migração `apps/server/src/db/migrations/064_blog.sql`).
- Painel: `pages/Blog.tsx` (lista, post e o markdown desenhado com elementos React, sem HTML cru) com `blog.css`; tela do dono `pages/BlogAdmin.tsx` em `/blog-posts` (menu Plataforma > Blog). A landing tem link para `/blog` no topo e no rodapé.

## Como funciona
- Fila `blog.run` (`QUEUES.blog`), de hora em hora no minuto 41: põe os 4 posts de partida uma vez só (apagar não traz de volta), gera até 4 ilustrações que faltam (3 tentativas cada) e escreve o post da semana no dia e hora escolhidos no painel (padrão segunda 9h, fuso da stack) se o último post não-de-partida tem mais de 6 dias.
- Redator: rota `blog` em Modelos (DeepSeek Flash, saída longa). Responde JSON; `cleanDraft` recusa texto curto, sem seções ou sem cena da capa, tira HTML e travessão, e o modelo tenta mais uma vez. Categoria da semana = a menos usada nos últimos 8 posts. Não pode inventar número, estudo ou preço.
- Ilustrações: rota `image` (Imagens), 16:9, estilo único `IMAGE_STYLE` (guache, cores vivas, fundo pastel, sem texto). Viram JPEG pelo navegador da stack (`htmlToPng` com `type: "jpeg"`); sem navegador fica o PNG. Guardadas no banco, servidas em `/api/blog/img/:id/:slot?v=` com cache imutável. Sem ilustração, o cartão mostra o Mascote num fundo da cor da categoria.
- Tudo passa pelo `Tracer` (trigger `blog`, `noCharge`) e aparece em Execuções. Post novo vira aviso no sininho do dono.
- SEO: `/blog` e `/blog/:slug` saem com título, descrição, og:image, canônico e JSON-LD no `<head>` (`blogPage`), mais `/sitemap.xml` e `/blog/feed.xml`.
- n8n: o post semanal já sai sozinho; `POST /api/internal/blog/write` (com a `X-Planejai-Key`) põe um post na fila para quem quiser disparar por fluxo.
