/**
 * Posts de partida do blog (entram uma vez, no primeiro boot com o blog vazio). Texto original do time; as ilustrações
 * saem da rota "Imagens" no worker, a partir de cover_prompt e inline_prompt (blog.ts, fillMissingImages).
 */
export interface SeedPost {
  slug: string;
  title: string;
  subtitle: string;
  category: string;
  daysAgo: number;
  cover_prompt: string;
  inline_prompt: string;
  body: string;
}

export const SEED_POSTS: SeedPost[] = [
  {
    slug: "como-planejar-a-semana-em-15-minutos",
    title: "Como planejar a semana em 15 minutos (e cumprir o plano)",
    subtitle: "Um ritual curto de domingo que tira a semana da cabeça e coloca no calendário.",
    category: "Dicas de produtividade",
    daysAgo: 1,
    cover_prompt:
      "Top-down still life on a soft pink background: an open weekly planner with colorful time blocks, a ceramic coffee mug, a green fountain pen, sticky notes, a small potted plant, a phone showing a chat, a croissant on a plate, scattered paper clips.",
    inline_prompt:
      "A cozy desk scene seen from above on a pale yellow background: a wall calendar page with seven colorful columns, an hourglass, a checklist on a clipboard, a cup of tea, a pair of reading glasses and a small alarm clock.",
    body: `Segunda-feira chega, as mensagens se acumulam e, quando você percebe, a semana já decidiu tudo por você. Não precisa ser assim. Um planejamento curto, feito uma vez por semana, resolve boa parte da sensação de estar sempre correndo atrás.

A ideia aqui não é montar um plano perfeito. É gastar quinze minutos para olhar a semana inteira de uma vez, escolher o que importa e deixar o resto com hora marcada.

## Por que planejar a semana funciona melhor que planejar o dia

Quando você planeja só o dia, cada manhã começa do zero. Você decide de novo o que fazer, sente de novo o peso das pendências e quase sempre esquece algo que estava combinado para quinta.

Olhando a semana inteira, você enxerga os compromissos fixos, os dias mais apertados e os buracos livres. Fica mais fácil encaixar uma tarefa grande no dia certo, em vez de empurrar para "amanhã" até virar urgência.

> **Dica:** escolha um horário fixo para o ritual, como domingo à noite ou segunda às 8h. O hábito pesa mais que o método.

## O ritual de 15 minutos, passo a passo

1. **Esvazie a cabeça (3 minutos).** Anote tudo que está pendente, sem filtro: contas, mensagens para responder, consultas, presentes, ideias.
2. **Olhe o calendário (2 minutos).** Veja os compromissos que já existem. Eles são o esqueleto da semana.
3. **Escolha três prioridades (3 minutos).** Das anotações, quais três coisas fariam a semana valer a pena? Só três.
4. **Dê hora para as prioridades (4 minutos).** Coloque cada uma num horário real do calendário, como se fosse uma reunião com você mesmo.
5. **Programe os lembretes (3 minutos).** Contas, remédios, aniversários e entregas viram lembretes com data. Assim você não precisa lembrar de lembrar.

[[imagem]]

## Como escolher as três prioridades certas

Uma boa prioridade tem duas características: ela move algo importante para você e ela só anda se você der atenção. Responder um e-mail rápido não é prioridade, é tarefa. Organizar a mudança, estudar para a prova ou fechar o orçamento do mês são prioridades.

Se tudo parece urgente, pergunte: **se só isso acontecesse esta semana, eu ficaria satisfeito?** A resposta costuma separar o importante do barulho.

## O que fazer quando o plano desanda

O plano vai desandar em algum momento, e tudo bem. Uma reunião surge, alguém fica doente, o trânsito engole a tarde. O segredo é ter uma regra simples para remarcar:

- Se perdeu o horário de uma prioridade, remarque no mesmo dia, nem que seja para a noite seguinte.
- Se a semana apertou de vez, corte uma das três prioridades em vez de tentar fazer tudo pela metade.
- Na quarta-feira, olhe o plano por dois minutos e ajuste o resto da semana.

## Ferramentas que ajudam (sem complicar)

Você não precisa de um sistema sofisticado. Um calendário, uma lista e lembretes já resolvem. O ponto é que essas coisas fiquem num lugar que você abre todo dia.

Para muita gente, esse lugar é o WhatsApp. Por isso o Planejai funciona ali: você manda "toda segunda às 8h me lembra de planejar a semana" ou um áudio com as pendências, e ele transforma em lembretes e compromissos na agenda, sem você abrir outro aplicativo.

| Parte do ritual | Onde fica melhor |
| --- | --- |
| Lista de pendências | Uma nota única, sempre a mesma |
| Prioridades da semana | Blocos no calendário |
| Contas e datas | Lembretes com dia e hora |
| Revisão de quarta | Um lembrete fixo de dois minutos |

## Perguntas frequentes

### Quanto tempo leva para virar hábito?

Depende da pessoa, mas o que mais ajuda é repetir no mesmo horário. Depois de algumas semanas o ritual fica automático e passa a levar menos de quinze minutos.

### E se eu tiver mais de três prioridades?

Escolha três mesmo assim e deixe as outras como tarefas comuns. Se sobrar tempo, elas entram. Se não sobrar, você já sabe que fez o que mais importava.

### Planejar no papel ou no celular?

O melhor lugar é o que você abre todos os dias. Se o celular está sempre na mão, faça por ele, com lembretes que avisam na hora certa.`,
  },
  {
    slug: "regra-50-30-20-como-dividir-o-salario",
    title: "Regra 50-30-20: como dividir o salário sem planilha complicada",
    subtitle: "Um jeito simples de saber quanto pode gastar, quanto guardar e onde o dinheiro está escapando.",
    category: "Dinheiro e finanças",
    daysAgo: 4,
    cover_prompt:
      "Top-down still life on a mint green background: a pink piggy bank, stacks of golden coins, a leather wallet with a credit card peeking out, a small paper receipt, a calculator, a glass jar with coins and a sprout growing from it, a pen.",
    inline_prompt:
      "Three glass jars of different sizes on a cream background, filled with coins and small paper notes, labeled only with simple colored dots (no text), with a few coins scattered and a small plant leaf, warm light.",
    body: `Chega o salário, as contas saem, e no dia 20 vem aquela pergunta: para onde foi o dinheiro? Antes de pensar em cortar tudo, vale ter uma regra simples para dividir o que entra. A regra 50-30-20 é uma das mais fáceis de aplicar e não exige planilha.

Ela não é uma lei. É um ponto de partida para você enxergar o seu mês e ajustar com calma.

## O que é a regra 50-30-20

A regra divide a renda líquida, o que cai na conta depois dos descontos, em três partes:

- **50% para o essencial:** moradia, contas de casa, mercado, transporte, saúde e escola.
- **30% para o estilo de vida:** restaurantes, delivery, lazer, assinaturas, roupas e presentes.
- **20% para o futuro:** reserva de emergência, dívidas e investimentos.

## Um exemplo com números

Veja como fica com uma renda líquida de R$ 3.000,00:

| Parte | Percentual | Valor por mês |
| --- | --- | --- |
| Essencial | 50% | R$ 1.500,00 |
| Estilo de vida | 30% | R$ 900,00 |
| Futuro | 20% | R$ 600,00 |

Se o essencial já passa de 50%, não é motivo para desespero. Isso é comum em cidades com aluguel alto. O ajuste costuma vir do estilo de vida, até o essencial caber de novo.

[[imagem]]

## Como descobrir quanto você gasta hoje

A regra só funciona se você souber os números reais. E o maior inimigo aqui é a memória: o café, o aplicativo de transporte e a assinatura esquecida somem da cabeça.

1. Anote cada gasto no momento em que ele acontece, nem que seja uma linha rápida.
2. No fim do mês, separe os gastos nas três partes.
3. Compare com os percentuais da regra e veja qual parte passou do limite.

> **Dica:** os gastos pequenos e frequentes costumam pesar mais do que a gente imagina. Olhe para eles primeiro.

Anotar tudo parece trabalhoso, mas fica leve quando é do jeito que você já fala. No Planejai, você manda "gastei 32 no almoço" ou a foto do comprovante no WhatsApp, e ele lança o gasto na categoria certa, com o total do mês somado sem erro de conta.

## O cartão de crédito entra onde?

O cartão não é uma categoria, é só a forma de pagar. Cada compra no cartão entra na parte a que pertence: mercado no essencial, cinema no estilo de vida. O cuidado é olhar a fatura antes de ela fechar, para não ser surpreendido no vencimento.

Se você já tem uma fatura atrasada, ela entra nos 20% do futuro até ser quitada. Juros do rotativo costumam ser dos mais altos do mercado, então essa dívida vem antes de qualquer investimento.

## Quando adaptar a regra

A regra 50-30-20 é um começo. Algumas situações pedem ajustes:

- **Renda variável:** use a média dos últimos meses e guarde a sobra dos meses bons.
- **Muitas dívidas:** inverta por um tempo e coloque mais no futuro, cortando do estilo de vida.
- **Objetivo grande à vista:** uma viagem ou a entrada de um imóvel pedem mais que 20% por alguns meses.

## Perguntas frequentes

### A regra vale para quem ganha pouco?

Vale como referência, mas com renda apertada o essencial costuma passar de 50%. Nesse caso, comece guardando qualquer valor fixo, mesmo pequeno, e aumente aos poucos.

### Reserva de emergência entra nos 20%?

Sim. Ela é a primeira coisa a montar dentro do futuro, antes de investimentos com mais risco.

### Preciso de planilha para seguir a regra?

Não. Basta anotar os gastos com categoria e olhar o total de cada parte no fim do mês. Um aplicativo ou um assistente faz a soma por você.`,
  },
  {
    slug: "assistente-no-whatsapp-ou-app-de-tarefas",
    title: "Assistente no WhatsApp ou app de tarefas: qual combina com a sua rotina?",
    subtitle: "As diferenças práticas entre abrir mais um aplicativo e resolver tudo numa conversa.",
    category: "Comparações",
    daysAgo: 8,
    cover_prompt:
      "Playful scene on a lilac background: a big smartphone showing colorful chat bubbles next to a tidy stack of app icons as wooden blocks, a checklist notepad, a paper airplane, a small alarm clock and a cactus, flat bold shapes.",
    inline_prompt:
      "Two paths diverging in a stylized landscape at sunset: one leads to a giant chat bubble shaped house, the other to a tower of colorful app tiles, a signpost without text in the middle, warm coral and violet palette.",
    body: `Quase todo mundo já baixou um aplicativo de tarefas cheio de boas intenções e abandonou depois de duas semanas. Não é falta de disciplina. Muitas vezes o problema é ter mais um lugar para lembrar de abrir.

Os assistentes no WhatsApp surgiram justamente para isso: em vez de levar sua rotina para um aplicativo novo, eles vão até onde você já está. Mas será que servem para todo mundo? Vamos comparar.

## Como funciona um app de tarefas

Um aplicativo de tarefas é uma lista organizada: você cria tarefas, separa por projetos, define datas e marca o que concluiu. Os melhores têm etiquetas, filtros e visão de calendário.

Ele funciona muito bem para quem gosta de estrutura e tem o hábito de revisar a lista todos os dias. O ponto fraco é a entrada: cada tarefa precisa ser digitada no lugar certo, do jeito certo.

## Como funciona um assistente no WhatsApp

Um assistente no WhatsApp é uma conversa. Você escreve ou manda um áudio do jeito que falaria com alguém: "me lembra de pagar a luz dia 10", "quanto gastei com mercado este mês?", "marca dentista quinta às 15h".

Ele entende o pedido, cria o lembrete, anota o gasto ou coloca o compromisso na agenda. Você não precisa saber onde cada coisa fica, só pedir.

[[imagem]]

## Comparação lado a lado

| Critério | App de tarefas | Assistente no WhatsApp |
| --- | --- | --- |
| Onde você usa | Um aplicativo a mais | A conversa que você já abre |
| Como anota | Digitando em campos | Texto, áudio ou foto |
| Lembretes | Notificação do app | Mensagem no WhatsApp |
| Organização visual | Muito boa | Painel separado, quando existe |
| Curva de aprendizado | Média | Quase nenhuma |

## Quando o app de tarefas é a melhor escolha

- Você gerencia projetos com muitas etapas e dependências.
- Gosta de ver tudo em quadros, colunas e filtros.
- Já tem o hábito de revisar a lista todo dia.

## Quando o assistente no WhatsApp ganha

- Você esquece de abrir aplicativos, mas nunca esquece de abrir o WhatsApp.
- Suas pendências chegam no meio do dia, andando, dirigindo ou entre uma reunião e outra.
- Você quer juntar lembretes, agenda e gastos num lugar só, sem configurar nada.

> **Dica:** o melhor sistema é o que você usa. Se a lista vive vazia, troque o método antes de culpar a sua força de vontade.

O Planejai é um assistente desse segundo tipo, com um detalhe: em vez de um robô só, ele tem um pequeno time de agentes, um para agenda, um para finanças, outro para pesquisa, que conversam entre si antes de te responder. E quando você quer ver tudo organizado, há um painel no navegador com agenda e finanças.

## Dá para usar os dois?

Dá, e muita gente faz isso. O app de tarefas fica com os projetos longos do trabalho, e o assistente cuida do dia a dia: contas, consultas, compras e recados. O importante é que cada coisa tenha um lugar só, para nada ficar duplicado.

## Perguntas frequentes

### Um assistente no WhatsApp é seguro?

Depende do serviço. Procure um que explique como guarda seus dados, permita apagar tudo e peça confirmação antes de qualquer ação com dinheiro ou com outras pessoas.

### Preciso aprender comandos?

Não. A graça de um assistente é entender a linguagem do dia a dia, inclusive áudio.

### E se eu mudar de ideia sobre um lembrete?

É só pedir na conversa: "cancela o lembrete da luz" ou "muda o dentista para sexta".`,
  },
  {
    slug: "agentes-de-ia-o-que-sao",
    title: "Agentes de IA: o que são e como um time de assistentes trabalha por você",
    subtitle: "Entenda a diferença entre um chatbot que responde e um agente que faz, sem jargão.",
    category: "Inteligência artificial",
    daysAgo: 12,
    cover_prompt:
      "Whimsical scene on a sky blue background: a team of small friendly round robots with different colored bodies working together around a big desk with a calendar, a wallet, a magnifying glass and an envelope, paper planes flying, simple flat shapes.",
    inline_prompt:
      "Stylized network of round colorful nodes connected by curved lines on a cream background, each node holding a simple icon object (a calendar page, a coin, a magnifying glass, an envelope), playful and clean composition.",
    body: `Você provavelmente já conversou com um chatbot: pergunta algo, recebe uma resposta. Os agentes de IA vão um passo além. Em vez de só responder, eles fazem coisas por você: consultam a agenda, anotam um gasto, pesquisam um preço, montam um lembrete.

Essa mudança, de responder para agir, é o que torna os assistentes pessoais realmente úteis no dia a dia.

## O que é um agente de IA

Um agente de IA é um modelo de linguagem com acesso a ferramentas. Ele lê o seu pedido, decide quais ferramentas usar, usa e depois te conta o resultado.

Por exemplo, ao receber "quanto gastei com mercado em setembro?", um chatbot comum diria que não tem acesso aos seus dados. Um agente consulta os gastos registrados, soma e responde com o valor.

## Chatbot, assistente e agente: qual a diferença

| Tipo | O que faz | Exemplo |
| --- | --- | --- |
| Chatbot | Responde com o que já sabe | Explica o que é juros compostos |
| Assistente | Conversa e guarda contexto | Lembra que você prefere respostas curtas |
| Agente | Usa ferramentas e age | Cria o lembrete da conta de luz |

[[imagem]]

## Por que um time de agentes e não um só

Um agente que faz tudo precisa conhecer centenas de ferramentas e regras ao mesmo tempo. Isso deixa as respostas mais lentas, mais caras e mais sujeitas a erro.

A alternativa é dividir o trabalho, como numa equipe de verdade:

1. Um **líder** conversa com você, entende o pedido e decide quem chamar.
2. **Especialistas** cuidam de cada assunto: agenda, finanças, pesquisa, e-mail, recados.
3. Os especialistas podem **consultar uns aos outros** quando o pedido cruza assuntos.
4. O líder **revisa** o que o time fez antes de responder.

É assim que o Planejai funciona. Quando você pede "agenda o dentista e me lembra de separar o dinheiro da consulta", o líder chama o especialista de agenda e o de finanças, e você recebe uma resposta só.

## Agentes podem errar?

Podem. Modelos de linguagem às vezes entendem errado um pedido ou inventam uma informação. Por isso, bons agentes seguem algumas travas:

- **Contas exatas:** valores calculados por ferramentas, nunca de cabeça.
- **Confirmação antes de agir:** nada de dinheiro, mensagem para outra pessoa ou apagar dados sem o seu "sim".
- **Transparência:** o agente diz o que fez e o que não conseguiu, em vez de fingir que fez.

> **Dica:** desconfie de qualquer assistente que mande mensagens ou mexa em dinheiro sem pedir sua confirmação.

## O que dá para delegar hoje

Algumas tarefas que agentes já fazem bem no dia a dia:

- Organizar compromissos e lembretes a partir de um áudio.
- Anotar gastos por foto do comprovante e mostrar o total por categoria.
- Pesquisar e comparar informações na internet.
- Ler um PDF longo e resumir o que importa.
- Mandar um recado para um contato, depois que você aprova o texto.

## Perguntas frequentes

### Agente de IA e assistente virtual são a mesma coisa?

Nem sempre. Todo agente é um tipo de assistente, mas nem todo assistente usa ferramentas para agir. O que define o agente é a capacidade de fazer, não só de responder.

### Preciso entender de tecnologia para usar?

Não. Você conversa normalmente, por texto ou áudio. Quem escolhe as ferramentas é o agente.

### Meus dados ficam com o agente?

Depende do serviço. Prefira os que explicam o que guardam, por quanto tempo, e deixam você apagar tudo quando quiser.`,
  },
];
