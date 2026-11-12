/**
 * As 100 dicas da semana depois do uso livre (week-tips.ts). Pedido do David em 2026-11-12: "100 estilos de mensagens,
 * com emojis, no estilo do WhatsApp, pro cliente usar e mandar no Planejai". Texto pronto (zero token), cada uma num
 * jeito diferente: pergunta, desafio, "sabia que", passo a passo, copia e cola, antes e depois...
 *
 * Regras de escrita: *negrito* e _itálico_ do WhatsApp, listas com "•", frases que a pessoa pode copiar entre aspas,
 * nada de travessão nem 📅/📆 (o WhatsApp mostra um dia fixo; use 🗓️). "{, nome}" vira ", Ana" (ou some sem nome).
 * `chat` = exemplo que vira imagem (a pessoa manda / o Planejai responde), para os dias que saem com foto.
 * Só prometa o que o assistente faz de verdade: confira em agent/team.ts antes de escrever uma dica nova.
 */
export type WeekTopic =
  | "lembretes"
  | "agenda"
  | "gastos"
  | "financas"
  | "compras"
  | "pesquisa"
  | "recados"
  | "audio"
  | "fotos"
  | "criar"
  | "time"
  | "memoria"
  | "rotina"
  | "conversa";

export interface WeekTip {
  id: string;
  topic: WeekTopic;
  text: string;
  chat?: { eu: string; planejai: string };
}

const tip = (id: string, topic: WeekTopic, text: string, chat?: WeekTip["chat"]): WeekTip => ({ id, topic, text, chat });

export const WEEK_TIPS: WeekTip[] = [
  // ⏰ lembretes
  tip(
    "l01",
    "lembretes",
    `⏰ *Esqueceu de novo? Comigo não!*

Oi{, nome}! Me manda do jeitinho que você falaria pra um amigo:
• "me lembra de pagar o boleto sexta às 10h"
• "daqui 40 minutos tira o bolo do forno"

Eu te chamo na hora certinha 😉`,
    { eu: "me lembra de pagar o boleto sexta às 10h", planejai: "Fechado! ⏰ Sexta às *10h* eu te lembro do *boleto*." },
  ),
  tip(
    "l02",
    "lembretes",
    `🔁 *Lembrete que se repete sozinho*

Sabia que eu faço lembrete toda semana, todo mês ou todo dia? Experimenta:
• "toda segunda 7h academia"
• "todo dia 5 me lembra do aluguel"

Você pede uma vez e eu cuido pra sempre 💜`,
    { eu: "todo dia 5 me lembra do aluguel", planejai: "Combinado! 🔁 Todo *dia 5* eu te lembro do *aluguel*." },
  ),
  tip(
    "l03",
    "lembretes",
    `💊 *Remédio na hora certa*

Se você ou alguém da família toma remédio, deixa comigo:
• "remédio de pressão às 8h e às 20h todo dia"

Eu aviso todo dia, sem falhar 🙏`,
  ),
  tip(
    "l04",
    "lembretes",
    `🧠 *Truque rápido*

Lembrou de algo no meio da rua? Manda um *áudio* de 3 segundos:
_"me lembra amanhã de ligar pro contador"_

Eu entendo, anoto e te chamo amanhã 🎙️`,
  ),
  tip(
    "l05",
    "lembretes",
    `🎂 *Nunca mais esquece aniversário*

Me conta os aniversários importantes:
• "aniversário da minha mãe é 12 de março"
• "dia 20 é aniversário do Pedro, me avisa um dia antes"

No dia eu te lembro, e você ainda ganha pontos com a família 😄`,
    { eu: "aniversário da minha mãe é 12 de março, me avisa um dia antes", planejai: "Anotado! 🎂 Dia *11 de março* eu te lembro do aniversário da sua mãe." },
  ),
  tip(
    "l06",
    "lembretes",
    `⏳ *Daqui a pouco...*

Pra coisas rápidas do dia a dia:
• "daqui 20 min me lembra de tirar a roupa da máquina"
• "em 1 hora me lembra de buscar as crianças"

Simples assim ✨`,
  ),
  tip(
    "l07",
    "lembretes",
    `📋 *Desafio do dia*

Pensa em *3 coisas* que você precisa fazer essa semana e me manda tudo numa mensagem só.

Eu separo, crio os lembretes e te aviso de cada uma no horário 💪`,
  ),
  tip(
    "l08",
    "lembretes",
    `🔄 *Mudou o horário? Fala comigo*

Não precisa apagar e criar de novo:
• "muda o lembrete do dentista pra 15h"
• "cancela o lembrete da academia de hoje"

Eu ajusto na hora 👌`,
  ),
  // 🗓️ agenda
  tip(
    "a01",
    "agenda",
    `🗓️ *Como tá sua semana?*

Me pergunta:
• "o que eu tenho amanhã?"
• "como tá minha semana?"

Eu te mando tudo organizadinho, dia por dia ☀️`,
    { eu: "o que eu tenho amanhã?", planejai: "🗓️ *Amanhã*\n• 9h Reunião com a equipe\n• 14h Dentista\n• 19h Academia" },
  ),
  tip(
    "a02",
    "agenda",
    `📍 *Compromisso com aviso antes*

Marca assim:
• "dentista quinta às 14h, me avisa 1 hora antes"

O horário do compromisso e o do aviso ficam separados, do jeito que você quiser 😉`,
  ),
  tip(
    "a03",
    "agenda",
    `🔗 *Usa Google Agenda?*

Dá pra ligar sua agenda do Google no painel, em *Integrações*. Aí é só falar:
• "marca reunião com o cliente terça às 10h"

E já aparece lá no seu Google também ✅`,
  ),
  tip(
    "a04",
    "agenda",
    `☀️ *Bom dia com resumo*

Que tal começar o dia sabendo tudo?
_"todo dia às 7h me manda o que eu tenho no dia"_

Vira seu café da manhã de organização ☕`,
  ),
  tip(
    "a05",
    "agenda",
    `🤔 *Tô livre?*

Antes de aceitar um convite, me pergunta:
• "tô livre sábado à tarde?"
• "tenho alguma coisa dia 15?"

Eu olho sua agenda e te respondo na hora 👀`,
  ),
  tip(
    "a06",
    "agenda",
    `📲 *Sua agenda também no painel*

Tudo que você marca comigo aparece no painel, em *Agenda*, com visão de dia, semana e mês.

Dá até pra arrastar um compromisso pra outro horário 🖐️`,
  ),
  tip(
    "a07",
    "agenda",
    `🗂️ *Semana organizada em 1 minuto*

Domingo à noite, me manda tudo que vem pela frente:
_"segunda reunião 9h, quarta médico 15h, sexta jantar 20h"_

Eu coloco tudo na agenda de uma vez 🙌`,
  ),
  // 💸 gastos
  tip(
    "g01",
    "gastos",
    `💸 *Anotar gasto em 2 segundos*

Gastou? Me fala:
• "gastei 35 no almoço"
• "uber 18"
• "mercado 230 no cartão"

Eu anoto e separo por categoria sozinho 🧾`,
    { eu: "gastei 35 no almoço", planejai: "Anotado! 🍽️ *R$ 35,00* em *Alimentação*." },
  ),
  tip(
    "g02",
    "gastos",
    `📊 *Pra onde foi meu dinheiro?*

Me pergunta:
• "quanto gastei esse mês?"
• "quanto gastei com comida?"

Eu te mostro na hora, com os números certinhos 💰`,
    { eu: "quanto gastei esse mês?", planejai: "📊 *Este mês*\n• Alimentação: *R$ 640,00*\n• Transporte: *R$ 210,00*\n• Casa: *R$ 980,00*" },
  ),
  tip(
    "g03",
    "gastos",
    `🧾 *Tirou foto do comprovante?*

Manda a foto da nota ou do comprovante pra mim.

Eu leio o valor e já anoto o gasto pra você 📸`,
  ),
  tip(
    "g04",
    "gastos",
    `🎙️ *Gasto por áudio também vale*

No caixa, com a mão ocupada? Manda um áudio:
_"gastei cento e vinte na farmácia"_

Eu entendo e anoto direitinho ✅`,
  ),
  tip(
    "g05",
    "gastos",
    `💵 *Entrou dinheiro? Me conta também*

• "recebi 3500 de salário"
• "entrou 200 do freela"

Assim eu te mostro quanto entrou, quanto saiu e quanto sobrou no mês 📈`,
  ),
  tip(
    "g06",
    "gastos",
    `✏️ *Errou o valor?*

Sem drama:
• "o almoço foi 42, não 35"
• "apaga o último gasto"

Eu corrijo na hora 😉`,
  ),
  tip(
    "g07",
    "gastos",
    `🔍 *Detetive do dinheiro*

Experimenta perguntar:
_"qual foi meu maior gasto essa semana?"_

Às vezes a resposta surpreende 😅`,
  ),
  tip(
    "g08",
    "gastos",
    `🗓️ *Calendário de gastos*

No painel, em *Finanças*, cada dia mostra quanto você gastou.

Dá pra ver num piscar de olhos os dias que pesaram no bolso 👀`,
  ),
  // 💰 finanças
  tip(
    "f01",
    "financas",
    `🎯 *Uma meta pra chamar de sua*

Quer juntar pra uma viagem, um carro, a reserva?
_"quero juntar 5 mil pra viagem até dezembro"_

Eu crio a meta e te ajudo a acompanhar cada passo 🚀`,
    { eu: "quero juntar 5 mil pra viagem até dezembro", planejai: "🎯 Meta criada: *Viagem*, *R$ 5.000,00* até *dezembro*. Bora juntar!" },
  ),
  tip(
    "f02",
    "financas",
    `🚦 *Limite por categoria*

Quer gastar menos com delivery?
_"meu limite de delivery é 300 por mês"_

Quando chegar perto, eu te dou um toque 🔔`,
  ),
  tip(
    "f03",
    "financas",
    `🏠 *Contas fixas no automático*

Aluguel, luz, internet...
_"a conta de luz vence todo dia 10"_

Eu te lembro antes de vencer e você nunca mais paga juros 🙌`,
    { eu: "a conta de luz vence todo dia 10", planejai: "💡 Conta fixa salva! Todo mês eu te lembro antes do *dia 10*." },
  ),
  tip(
    "f04",
    "financas",
    `💳 *Cartão sob controle*

Cadastra seu cartão e me fala:
• "gastei 150 no Nubank"
• "quanto tá a fatura?"

Eu acompanho a fatura e te aviso antes de fechar 💜`,
  ),
  tip(
    "f05",
    "financas",
    `🛍️ *Compra parcelada*

_"comprei uma TV de 2400 em 10x no cartão"_

Eu divido certinho nos próximos meses, centavo por centavo 🧮`,
  ),
  tip(
    "f06",
    "financas",
    `🗓️ *Seu mês começa quando o salário cai*

Recebe dia 5? Me fala:
_"meu mês começa dia 5"_

Aí os resumos e limites seguem o *seu* mês, não o do calendário 😉`,
  ),
  tip(
    "f07",
    "financas",
    `🏦 *Extrato do banco em segundos*

No painel, em *Finanças*, dá pra importar o arquivo *OFX* do seu banco.

Eu separo tudo por categoria e não duplico nada ✨`,
  ),
  tip(
    "f08",
    "financas",
    `🧮 *Conta difícil? Deixa comigo*

• "quanto é 15% de 1.280?"
• "divide 486 entre 4 pessoas"

Eu calculo certinho, sem chute 🤓`,
    { eu: "divide 486 entre 4 pessoas", planejai: "🧮 Fica *R$ 121,50* pra cada um." },
  ),
  tip(
    "f09",
    "financas",
    `📈 *Resumo do mês num gráfico*

Me pede:
_"me manda um gráfico dos meus gastos do mês"_

Eu mando uma imagem bonitinha pra você bater o olho 📊`,
  ),
  // 🛒 compras
  tip(
    "c01",
    "compras",
    `🛒 *Lista de compras que não se perde*

• "coloca arroz, leite e café na lista"
• "o que tem na minha lista?"

No mercado é só me pedir que eu mando tudo 😉`,
    { eu: "coloca arroz, leite e café na lista", planejai: "🛒 *Lista de compras*\n• Arroz\n• Leite\n• Café" },
  ),
  tip(
    "c02",
    "compras",
    `✅ *Comprou? Tira da lista*

_"já comprei o leite e o café"_

Eu risco da lista e fica só o que falta 🧺`,
  ),
  tip(
    "c03",
    "compras",
    `🏷️ *Achar o menor preço*

Vai comprar alguma coisa?
_"qual o menor preço do fone JBL Tune 520?"_

Eu procuro nas lojas e te mando os links mais baratos 💸`,
  ),
  tip(
    "c04",
    "compras",
    `👀 *De olho no preço pra você*

_"me avisa quando a air fryer baixar de 300"_

Eu fico de olho e te chamo quando cair 📉`,
  ),
  tip(
    "c05",
    "compras",
    `🍝 *Receita com o que tem em casa*

_"tenho frango, batata e creme de leite, o que faço pra janta?"_

Eu te passo uma receita fácil, com o passo a passo 👩‍🍳`,
    { eu: "tenho frango, batata e creme de leite, o que faço?", planejai: "🍗 *Frango cremoso com batata*\n1. Doure o frango\n2. Junte a batata\n3. Finalize com o creme de leite" },
  ),
  // 🔎 pesquisa
  tip(
    "p01",
    "pesquisa",
    `🎬 *Cinema hoje?*

_"que filmes estão passando no cinema perto de mim?"_

Eu procuro sessões e horários e te mando tudo 🍿`,
  ),
  tip(
    "p02",
    "pesquisa",
    `📍 *O mais perto de você*

• "farmácia aberta mais perto"
• "petshop perto de casa"

Eu te mando endereço, distância e telefone 🗺️`,
    { eu: "farmácia aberta mais perto", planejai: "💊 *Drogaria Central*\n📍 Rua das Flores, 120 (*600 m*)\n📞 (11) 3333-4444" },
  ),
  tip(
    "p03",
    "pesquisa",
    `📰 *Notícia sem rolar o feed*

_"quais as principais notícias de hoje?"_

Eu resumo pra você em poucas linhas ☕`,
  ),
  tip(
    "p04",
    "pesquisa",
    `🍽️ *Onde comer hoje?*

_"me indica um restaurante japonês bom aqui perto"_

Eu procuro com avaliação e te mando as melhores opções 🍣`,
  ),
  tip(
    "p05",
    "pesquisa",
    `❓ *Dúvida rápida?*

Pergunta qualquer coisa:
• "como tirar mancha de vinho da roupa?"
• "quanto tempo cozinha o ovo pra ficar mole?"

Eu respondo na hora 😄`,
  ),
  tip(
    "p06",
    "pesquisa",
    `✈️ *Planejando uma viagem?*

_"o que fazer em Gramado em 3 dias?"_

Eu monto um roteiro dia por dia pra você 🧳`,
    { eu: "o que fazer em Gramado em 3 dias?", planejai: "🧳 *Gramado em 3 dias*\n• Dia 1: Lago Negro e centro\n• Dia 2: Snowland\n• Dia 3: Canela e cascata" },
  ),
  tip(
    "p07",
    "pesquisa",
    `🔔 *Fico de olho por você*

_"me avisa quando abrirem os ingressos do show"_

Eu acompanho e te chamo quando tiver novidade 👀`,
  ),
  tip(
    "p08",
    "pesquisa",
    `📚 *Explica de um jeito fácil*

_"me explica juros compostos como se eu tivesse 10 anos"_

Aprender comigo é leve, prometo 🤓`,
  ),
  // 📞 recados
  tip(
    "r01",
    "recados",
    `📞 *Eu falo com o estabelecimento por você*

_"pergunta no petshop se tem horário de banho sábado"_

Eu mando mensagem no WhatsApp deles, converso e te trago a resposta 🐶`,
    { eu: "pergunta no petshop se tem banho sábado de manhã", planejai: "Falei com o *PetCamp* 🐶 Tem às *9h* e às *11h*. Quer que eu marque?" },
  ),
  tip(
    "r02",
    "recados",
    `💇 *Marcar horário sem ficar no telefone*

_"marca um corte no salão pra sexta à tarde, se tiver às 17h pode confirmar"_

Eu negocio, confirmo e já crio o lembrete 💅`,
  ),
  tip(
    "r03",
    "recados",
    `💬 *Quer mandar uma mensagem pra alguém?*

_"manda pra Ana que eu chego às 8"_

Eu te mostro o texto, você diz *sim* e eu envio ✉️`,
  ),
  tip(
    "r04",
    "recados",
    `🏥 *Orçamento sem dor de cabeça*

_"pergunta o preço da consulta na clínica São Lucas"_

Eu converso com eles e te trago tudo anotado, com valor e horários 🗒️`,
  ),
  tip(
    "r05",
    "recados",
    `👀 *Acompanha tudo pelo painel*

Cada conversa que eu tenho com estabelecimentos fica em *Recados*, no painel.

Você vê tudo que foi dito, em tempo real 📲`,
  ),
  tip(
    "r06",
    "recados",
    `📎 *Arquivo do estabelecimento chega pra você*

Se a clínica ou a loja mandar PDF, foto ou orçamento na conversa, eu te encaminho aqui e guardo em *Documentos* 📁`,
  ),
  // 🎙️ áudio
  tip(
    "u01",
    "audio",
    `🎙️ *Preguiça de digitar?*

Manda áudio! Eu entendo tudinho:
_"amanhã tenho dentista às 3, me lembra meio-dia, e anota que gastei 50 no posto"_

Faço tudo de uma vez 🙌`,
  ),
  tip(
    "u02",
    "audio",
    `🔊 *Quer a resposta em áudio?*

É só pedir:
_"me responde em áudio"_

Ótimo pra quando você tá dirigindo ou com a mão ocupada 🚗`,
  ),
  tip(
    "u03",
    "audio",
    `📝 *Áudio longo do grupo?*

Encaminha pra mim o áudio de 5 minutos e pergunta:
_"resume pra mim"_

Eu te conto o principal em 3 linhas ⚡`,
  ),
  tip(
    "u04",
    "audio",
    `🗣️ *Fala do seu jeito*

Não precisa de comando certinho. Pode falar como fala com um amigo, com gíria, com "hmm", com tudo.

Eu entendo 😄`,
  ),
  // 📸 fotos e documentos
  tip(
    "o01",
    "fotos",
    `📸 *Manda foto que eu leio*

Cardápio, placa, receita, bula, convite...
Manda a foto e pergunta o que quiser 👀`,
  ),
  tip(
    "o02",
    "fotos",
    `📄 *PDF grande? Eu resumo*

Contrato, boleto, apostila...
Manda o arquivo e pergunta:
• "o que é importante aqui?"
• "quando vence esse boleto?"

Eu leio por você 🤓`,
  ),
  tip(
    "o03",
    "fotos",
    `🎉 *Recebeu um convite?*

Manda a foto do convite de aniversário ou casamento.

Eu pego data, hora e lugar e já coloco na sua agenda 🗓️`,
  ),
  tip(
    "o04",
    "fotos",
    `🗂️ *Seus documentos guardados*

Tudo que você me manda fica em *Documentos*, no painel.

Precisou? _"me manda aquele PDF do contrato"_ e eu te envio de volta 📁`,
  ),
  tip(
    "o05",
    "fotos",
    `🌿 *Que planta é essa?*

Manda a foto de uma planta, um bicho, um prato...
_"o que é isso?"_

Eu te conto 🔍`,
  ),
  // 🎨 criar
  tip(
    "i01",
    "criar",
    `🎨 *Resumo em imagem*

_"faz um mapa mental sobre a Revolução Francesa"_

Eu mando uma imagem organizada, ótima pra estudar 🧠`,
  ),
  tip(
    "i02",
    "criar",
    `📑 *PDF prontinho*

_"faz um PDF com uma dieta de 7 dias"_
_"monta um PDF com o roteiro da viagem"_

Eu crio e te mando o arquivo 📄`,
  ),
  tip(
    "i03",
    "criar",
    `✍️ *Precisa escrever algo?*

• "escreve uma mensagem de aniversário pro meu pai"
• "me ajuda a responder esse e-mail do chefe"

Eu escrevo do jeitinho que você precisa 💌`,
    { eu: "escreve uma mensagem de aniversário pro meu pai", planejai: "🎂 *Pai*, feliz aniversário! Obrigado por cada conselho e cada abraço. Te amo! 💛" },
  ),
  tip(
    "i04",
    "criar",
    `🖼️ *Imagem do zero*

_"cria uma imagem de um gatinho astronauta"_

Dá pra usar no status, no convite, onde quiser 🚀`,
  ),
  tip(
    "i05",
    "criar",
    `📋 *Passo a passo em imagem*

_"faz um passo a passo de como trocar o pneu"_

Eu mando bonitinho, numa imagem só 🛞`,
  ),
  // 🤝 time
  tip(
    "t01",
    "time",
    `🤝 *Você tem um time inteiro*

Por trás de mim tem especialistas: agenda, finanças, pesquisa, recados...

Você fala só comigo e eu chamo quem precisa 💜`,
  ),
  tip(
    "t02",
    "time",
    `🏋️ *Crie seu próprio especialista*

_"cria um especialista de academia pra montar meus treinos"_

Ele entra no seu time e fica do seu lado 💪`,
  ),
  tip(
    "t03",
    "time",
    `🐾 *Um especialista só pro seu pet*

_"cria um especialista pra cuidar das vacinas e banhos do Thor"_

Ele lembra de tudo e te dá dicas 🐶`,
  ),
  tip(
    "t04",
    "time",
    `👥 *Conheça o time no painel*

Em *Especialistas*, no painel, você vê quem faz o quê e pode ajustar o jeito de cada um trabalhar 🧩`,
  ),
  tip(
    "t05",
    "time",
    `📖 *Um professor particular*

_"cria um especialista de inglês pra conversar comigo todo dia"_

Aprender conversando no WhatsApp é bem mais fácil 🇺🇸`,
  ),
  // 🧠 memória
  tip(
    "m01",
    "memoria",
    `🧠 *Eu guardo pra você*

• "lembra que o pediatra do Lucas é o Dr. Paulo"
• "anota que o tamanho do sapato do Lucas é 32"

Depois é só perguntar 😉`,
    { eu: "qual o tamanho do sapato do Lucas?", planejai: "👟 O Lucas calça *32*." },
  ),
  tip(
    "m02",
    "memoria",
    `🚗 *Onde eu parei o carro?*

Ao estacionar:
_"parei no piso G2, vaga 48"_

Na volta é só perguntar 😅`,
  ),
  tip(
    "m03",
    "memoria",
    `💡 *Me conta seus gostos*

_"eu não como carne"_
_"gosto de resposta curta"_

Eu aprendo seu jeito e capricho cada vez mais 💜`,
  ),
  tip(
    "m04",
    "memoria",
    `🎁 *Lista de presentes*

_"anota que a Ju quer um livro da Colleen Hoover"_

No aniversário dela, você já sabe o que dar 🎀`,
  ),
  tip(
    "m05",
    "memoria",
    `🔒 *Você no controle*

Quer que eu esqueça algo?
_"esquece o que eu falei sobre o pediatra"_

Eu apago na hora 🧹`,
  ),
  // 🌱 rotina
  tip(
    "h01",
    "rotina",
    `💧 *Bebeu água hoje?*

_"me lembra de beber água a cada 2 horas"_

Seu corpo agradece 🥤`,
  ),
  tip(
    "h02",
    "rotina",
    `🌙 *Dormir mais cedo*

_"todo dia às 22h30 me lembra de largar o celular"_

Pequeno hábito, grande diferença 😴`,
  ),
  tip(
    "h03",
    "rotina",
    `🏃 *Bora mexer o corpo?*

_"segunda, quarta e sexta às 18h me lembra de treinar"_

Eu sou seu parceiro de treino que não deixa você furar 💪`,
  ),
  tip(
    "h04",
    "rotina",
    `📖 *10 páginas por dia*

_"todo dia às 21h me lembra de ler"_

Em um mês são uns 2 livros 📚`,
  ),
  tip(
    "h05",
    "rotina",
    `🧘 *Um minuto pra você*

_"me lembra de meditar às 7h todo dia"_

Começar o dia com calma muda tudo 🌅`,
  ),
  tip(
    "h06",
    "rotina",
    `🍽️ *Cardápio da semana*

_"monta um cardápio saudável pra semana"_

E se quiser, eu já transformo em lista de compras 🥗`,
  ),
  tip(
    "h07",
    "rotina",
    `🧹 *Casa em ordem*

_"todo sábado 9h me lembra da faxina"_
_"dia 1 de cada mês me lembra de trocar o filtro"_

A casa agradece ✨`,
  ),
  // 💬 conversa
  tip(
    "v01",
    "conversa",
    `💬 *Bora conversar?*

Eu tô aqui pra ajudar com o que precisar. Que tal começar com:
_"me ajuda a organizar minha semana"_

Te espero 😊`,
  ),
  tip(
    "v02",
    "conversa",
    `🤔 *Sabia que dá pra pedir várias coisas de uma vez?*

_"me lembra do dentista quinta 14h, anota que gastei 80 no mercado e coloca pão na lista"_

Eu faço tudo numa tacada só ⚡`,
    { eu: "me lembra do dentista quinta 14h, anota 80 no mercado e põe pão na lista", planejai: "Feito! ✅\n• ⏰ Dentista *quinta 14h*\n• 💸 *R$ 80,00* em Mercado\n• 🛒 *Pão* na lista" },
  ),
  tip(
    "v03",
    "conversa",
    `🎲 *Sem ideia do que fazer hoje?*

_"me dá 3 ideias de programa barato pro fim de semana"_

Eu te dou opções pertinho de você 🌳`,
  ),
  tip(
    "v04",
    "conversa",
    `😂 *Um respiro no dia*

Pede uma piada, uma curiosidade, uma frase boa:
_"me conta uma curiosidade"_

Nem tudo precisa ser trabalho 😄`,
  ),
  tip(
    "v05",
    "conversa",
    `🎁 *Indique um amigo*

Gostou de mim? No painel, em *Convites*, tem o seu link pra chamar amigos.

Quem assina pelo seu convite te dá desconto na mensalidade 💜`,
  ),
  tip(
    "v06",
    "conversa",
    `🙋 *Faz uma pergunta difícil*

Testa eu:
_"me ajuda a decidir entre alugar ou financiar um apê"_

Eu te mostro os prós e contras com calma 🏡`,
  ),
  tip(
    "v07",
    "conversa",
    `📱 *Me salva nos contatos*

Pra não perder nenhuma mensagem minha, salva esse número como *Planejai* 💜

E me fixa no topo da conversa 📌`,
  ),
  tip(
    "v08",
    "conversa",
    `💜 *O que você mais quer resolver?*

Dinheiro, agenda, rotina, estudos...
Me conta numa frase e eu te mostro por onde começar ✨`,
  ),
  tip(
    "v09",
    "conversa",
    `💡 *Copia e cola*

Escolhe uma e me manda agora:
• "o que eu tenho amanhã?"
• "quanto gastei essa semana?"
• "me lembra de beber água às 15h"

Leva 2 segundos 😉`,
  ),
  tip(
    "v11",
    "conversa",
    `📲 *Tem app também*

No painel tem chat comigo, agenda, finanças e muito mais.
Dá pra instalar no celular como app, direto pelo navegador 🚀`,
  ),
  tip(
    "v12",
    "conversa",
    `🌟 *Um dia mais leve*

Me conta: o que tá pesando hoje?
Às vezes organizar em voz alta já ajuda, e eu tô aqui pra isso 🤍`,
  ),
  tip(
    "v13",
    "conversa",
    `✈️ *Checklist de viagem*

_"faz um checklist do que levar numa viagem de praia de 5 dias"_

Nada fica pra trás 🏖️`,
  ),
  tip(
    "v14",
    "conversa",
    `🎉 *Organizando uma festa?*

_"me ajuda a organizar um churrasco pra 15 pessoas"_

Eu calculo carne, bebida e monto a lista 🍖`,
    { eu: "churrasco pra 15 pessoas, quanto de carne?", planejai: "🍖 Pra *15 pessoas*, uns *6 kg* de carne (400 g por pessoa)." },
  ),
  tip(
    "v15",
    "conversa",
    `🧑‍🎓 *Hora de estudar*

_"me faz 5 perguntas sobre a matéria de biologia"_

Eu viro seu simulado particular 📝`,
  ),
  tip(
    "v17",
    "conversa",
    `👶 *Rotina das crianças*

• "me lembra da vacina do Davi dia 20"
• "toda terça 15h natação da Lara"

Eu cuido dos horários da família toda 👨‍👩‍👧`,
  ),
  tip(
    "v18",
    "conversa",
    `🚗 *Carro em dia*

• "me lembra da revisão do carro em março"
• "IPVA vence em janeiro, me avisa antes"

Sem multa e sem susto 🔧`,
  ),
  tip(
    "v19",
    "conversa",
    `🐶 *Pet feliz*

_"me lembra do vermífugo da Mel a cada 3 meses"_

E se quiser, eu marco o banho no petshop pra você 🛁`,
  ),
  tip(
    "v21",
    "conversa",
    `📝 *Lista de tarefas*

_"minhas tarefas de hoje: mandar relatório, ligar pro banco e pagar a luz"_

Eu organizo e te lembro de cada uma ✅`,
  ),
];
