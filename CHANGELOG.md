# Versões do Planejai

## v1.2.0 (2026-10-08)

- Recados: o assistente fala com o estabelecimento por você e agenda dentro do que você liberou
- Teste que varre as telas com duas contas e o dono: ninguém vê o dado particular do outro
- Rótulos dos campos ligados aos campos em todas as telas (leitor de tela e clique no rótulo)
- Gráficos e imagens do WhatsApp nas cores do Mochi, iguais ao painel
- Execuções mais fiéis: Parcial quando para no meio, rodando órfã fechada, resumo no custo e CPU da máquina
- Prompt do CTO revisado e sem repetição; especialistas mais econômicos e resposta cortada marcada no log
- Ferramentas com descrição enxuta, guia do n8n só quando precisa e raciocínio baixo em toda chamada
- Comprovante na foto vira despesa sozinho, com categoria automática
- Cobrança: aviso também no painel, Asaas mostra sandbox ou produção e trata apagada, restaurada e pedido de estorno
- API interna com teto diário e ritmo para quem não é cliente; media_url passa pelo net.ts
- Lugar perto sem abrir o navegador, e navegador só como último recurso
- Execuções e gravações de cliente mostram só métrica para o dono; texto fica com a pessoa
- Testes limpam o Redis antes de cada arquivo e o gráfico só roda com navegador
- Cabeçalhos de segurança, erro do banco sem vazar, proxy confiável e tempo máximo de consulta
- Sobe @fastify/static para 10.1.5 (corrige path traversal e bypass de rota)
- Telas Servidor e Armazenamento para o dono: memória, banco, Redis e quanto cada cliente ocupa
- Banho roxo ao clicar nos botões da landing, sem o Mochi
- Convite por código de 24h e cadastro em etapas com Mochis fantasiados
- Landing com movimento: entrada em cascata, Mochi que acompanha a rolagem e cortina ao entrar
- Landing pública do Planejai com o Mochi e conversa animada
- Preto e branco com o roxo do Mochi nos pontos estratégicos
- Revert "Base em bege suave, com a paleta do Mochi só em pontos escolhidos"
- Base em bege suave, com a paleta do Mochi só em pontos escolhidos
- Base em preto e branco, com a paleta do Mochi só em pontos escolhidos
- Efeitos da skiper40 nos links, abas e menu, refeitos em CSS
- Especialistas também leem o que a pessoa contou no cadastro
- Telefone formatado, US$ com vírgula e "1 pessoa ativa" de volta
- Volta o visual do painel para antes do redesenho (pedido do dono)
- Celular: números do Início numa faixa só e Agenda abrindo em lista
- Perguntas de boas-vindas no cadastro: uma por tela, com respostas que abrem outras
- Trilho do iPad com divisória entre seções e Mochi menor no login do celular
- Telefone formatado, custo com vírgula, plural de pessoas e Últimos meses com um mês só
- Visual novo do painel: papel branco com o violeta só nos destaques
- CLAUDE.md na raiz e skill planejai dividida por assunto
- CI com lint, sem arm/v7 e sem rodar para mudança só de texto; guia do repositório privado
- Consulta entre colegas continua de onde parou e descrição da consult_ fica curta
- Mensagem nova de conversa ocupada volta para a fila em vez de prender uma vaga do worker
- Limite diário conta só hoje, conta com menos não vira faixa e erro de ferramenta lido pelo campo
- Nova tentativa da fila não repete ação que já rodou
- Ação sensível só sai com o "sim" da pessoa, conferido pelo servidor
- Teste de reconexão espera o 'connected' chegar ao banco em vez de ler logo após session.connected
- Celular: "Mais" compacto e translúcido, flutuando acima da barra; desfoque volta a funcionar
- Menu lateral e barra do celular na cor da noite do Mochi; tela de assinatura em cartão
- Regras financeiras: avisos do Asaas no WhatsApp, indicação, lembretes e contas fixas; barra do celular só com ícones
- Acompanhamentos de 1 semana com aviso a cada olhada, tela configurável e barra do celular com 4 botões
- Trava: o assistente só diz que fez quando a ferramenta confirmou; data sem ano não vira 2020
- CI: push novo cancela o anterior do mesmo branch
- Tavily pela stack (TAVILY_API_KEY) e CI sem apt-get travando
- Foto com vários gastos vira um lançamento por item e pedido antigo não se repete
- Pesquisador mais barato: menos fontes por busca e páginas já lidas não são pagas de novo
- Folhas do celular acompanham o teclado e não quebram ao fechar ou usar select
- Mochi no ícone do app e o roxo dele nos destaques do painel
- Telas particulares, Nico com controle total das finanças, menu agrupado e n8n com estado real
- Assinatura mensal pelo Asaas: configuração no admin, tela do cliente e dias grátis
- Painel: sem barra de rolagem, carregando só na abertura, time com o Mochi e visual sem degradê
- Painel: toque e animações de app nativo, confirmações próprias e Execuções em módulos
- Servidor: rotas do painel e sessão do WhatsApp divididas em módulos
- Agentes: time próprio por pessoa, criado na conversa, e automações do n8n mais seguras
- Convites: quem já usa o Planejai não recebe convite de novo, e o recado chega no aceite
- Skills do Claude Code no repositório (frontend, arquitetura, animação, React)
- Stack: LOGIN_CODE explícito


## v1.1.0 (2026-10-07)

- Painel: notificações, documentos, código de login, Meet, mapa, Execuções nova e WhatsApp que religa sozinho


## v1.0.0 (2026-10-07)

- n8n ligado pela rede, automações criadas pelo assistente e versões (releases)
- README completo: deploy Swarm, variáveis, WhatsApp, n8n, segurança e operação
- Segurança, privacidade e custos: correções da revisão geral
- Mochi como ícone do app, botão Atualizar sem tela branca e componentes animados
- Telegram, API interna para o n8n, eventos e ferramentas do n8n
- Mochi 3: igual à referência, corpo parado e expressivo só pelos olhos
- Mochi 2: textura de silicone fofa, 31 carinhas com efeitos e roupinhas novas
- Mochi: brilho colorido por humor, tapa e óculos que sobem para a testa
- Mochi: expressões aparecem sem os óculos no guarda-roupa
- Mochi: novo mascote animado com expressões e roupinhas
- Imagens simples sob pedido (mapa mental etc), botões legíveis e telas que cabem no notebook
- Agenda estilo Google Agenda, barra flutuante com rolagem e nova visão de Finanças
- Limites sempre visíveis em Finanças, também para o dono
- Mais cor, navegação instantânea, puxar para atualizar e aviso de versão nova
- Mascote volta ao original e agentes viram pessoinhas a traço
- Limites de gastos, gráficos, filas, reunião noturna e carinhas dos agentes
- Agenda estilo Google, Finanças por categoria, menu Mais em quadrados e menos chamadas de IA
- Mensagens sem traço nem travessão e lembrete que passou é apagado com a memória
- Reação temática instantânea antes da IA e vibração no toque também no iPhone
- Respostas mais rápidas e com avisos enquanto pesquisa
- Stack Swarm: worker atualiza parando o antigo antes (uma conexão do WhatsApp por vez)
- Espera o Postgres na subida em vez de sair com erro
- Remove dump.rdb do Redis local e ignora
- Visual minimalista, entrada por convite e agentes que melhoram sozinhos
- Travas de segurança: tempo máximo por resposta, limites de uso e blindagem do agente
- WhatsApp volta a escutar sozinho depois de um redeploy
- Dashboard como app nativo no celular (PWA)
- Integrações revisadas campo a campo e Mercado Livre (OAuth + busca de produtos)
- Painéis super admin/admin, Redis 24h, documentos, gastos automáticos e pesquisa gravada
- Stack Swarm + Traefik para autoplanejai.tekvosoft.com
- Agentes conversando entre si e WhatsApp próprio via Baileys
- Plataforma Planejai: agente de WhatsApp com time de agentes, dashboard e deploy multi-arch

