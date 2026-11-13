import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { many, one, query } from "./db/pool.js";
import { attachServerPhoto } from "./feed.js";

/**
 * Pessoas de exemplo da rede: perfis com nome, bio e posts (vários com ilustração), que curtem e comentam os posts do @planejai
 * (os de partida, os da pauta, os do blog e os do status do WhatsApp) e uns dos outros, para o feed não parecer vazio.
 * Pedido do David (2026-11-12). Sem IA: os comentários são texto pronto.
 *
 * Cada pessoa é um registro em `users` com telefone "planejai-ex-<chave>" e status "blocked" (não recebe mensagem,
 * não entra em rotina nenhuma e fica fora da lista de Pessoas). Curtidas e comentários chegam aos poucos, com a hora
 * de cada um alguns minutos depois do post, e nunca no futuro; `feed_comments.source` impede repetir.
 * Não mexem em post de gente de verdade.
 *
 * Desde 2026-11-13 (David: "crie mais pessoas, fotos e tudo mais"): 28 pessoas, posts com ilustração (arquivos em
 * `assets/rede/<nome>.jpg`, desenhados em código com os emojis Fluent da Microsoft, licença MIT; não são fotos de
 * gente de verdade), destaques fixos em alguns perfis e uns status por dia para a fileira não ficar vazia.
 */

const ART = join(dirname(fileURLToPath(import.meta.url)), "assets", "rede");
/** Ilustração de um post de exemplo (null se o arquivo não veio na imagem: o post sai só com o texto). */
function art(name: string) {
  try {
    return readFileSync(join(ART, `${name}.jpg`));
  } catch {
    return null;
  }
}

export const EXAMPLE_PREFIX = "planejai-ex-";

export const PEOPLE: { key: string; name: string; handle: string; bio: string }[] = [
  { key: "carol", name: "Carolina Mendes", handle: "carol.mendes", bio: "Mãe do Theo e contadora. Me organizo por áudio, entre uma reunião e outra." },
  { key: "rodrigo", name: "Rodrigo Alves", handle: "rodrigo.alves", bio: "Motorista de app. Cada corrida e cada tanque anotados." },
  { key: "bia", name: "Beatriz Nunes", handle: "bia.nunes", bio: "Estudante de enfermagem aprendendo a fechar o mês." },
  { key: "fernando", name: "Fernando Prado", handle: "fernando.prado", bio: "Pai de duas e cozinheiro de fim de semana." },
  { key: "ju", name: "Juliana Ferraz", handle: "ju.ferraz.doces", bio: "Confeiteira. Encomendas, agenda e caixa no mesmo lugar." },
  { key: "marcos", name: "Marcos Vieira", handle: "prof.marcos.vieira", bio: "Professor de matemática. Juros compostos são meu assunto favorito." },
  { key: "luana", name: "Luana Santana", handle: "lu.santana", bio: "Designer freelancer, organizando a vida um lembrete por vez." },
  { key: "edu", name: "Eduardo Camargo", handle: "edu.camargo", bio: "Corredor amador juntando para a primeira maratona." },
  { key: "cidinha", name: "Aparecida Rocha", handle: "cidinha.rocha", bio: "Aposentada, avó de cinco e fã de mandar áudio." },
  { key: "gabi", name: "Gabriela Torres", handle: "gabi.torres", bio: "Recém-casada, montando a primeira casa sem dívida." },
  { key: "paula", name: "Paula Ribeiro", handle: "paula.ribeiro", bio: "Nutricionista. Marmita de domingo é meu esporte." },
  { key: "thiago", name: "Thiago Moreira", handle: "thiago.moreira", bio: "Dev, pai da Mel (a cachorra) e colecionador de planilhas aposentadas." },
  { key: "lucas", name: "Lucas Barbosa", handle: "lucas.barbosa", bio: "Barbeiro. Agenda cheia e caixa em dia." },
  { key: "renata", name: "Renata Queiroz", handle: "renata.queiroz", bio: "Advogada. Corro atrás de prazo e de promoção de passagem." },
  { key: "vini", name: "Vinícius Lopes", handle: "vini.lopes", bio: "Estudante de engenharia. Estágio, república e miojo gourmet." },
  { key: "sandra", name: "Sandra Oliveira", handle: "sandra.oliveira", bio: "Costureira. Cada encomenda no seu dia." },
  { key: "caio", name: "Caio Martins", handle: "caio.martins", bio: "Personal trainer. Treino marcado é treino feito." },
  { key: "helena", name: "Helena Duarte", handle: "helena.duarte", bio: "Professora de inglês e viajante de feriado." },
  { key: "rafa", name: "Rafael Souza", handle: "rafa.souza", bio: "Fotógrafo de casamento. Sábado é dia de trabalho." },
  { key: "tati", name: "Tatiane Gomes", handle: "tati.gomes", bio: "Manicure e mãe da Alice. Juntando para o salão próprio." },
  { key: "joao", name: "João Pedro Lima", handle: "joaopedro.lima", bio: "Entregador. Meta do ano: moto quitada." },
  { key: "marina", name: "Marina Castro", handle: "marina.castro", bio: "Arquiteta. Planta baixa e conta baixa." },
  { key: "jorge", name: "Jorge Batista", handle: "jorge.batista", bio: "Aposentado, pescador de sábado e tesoureiro do condomínio." },
  { key: "isa", name: "Isabela Freitas", handle: "isa.freitas", bio: "Veterinária. Três gatos e uma reserva de emergência." },
  { key: "bruno", name: "Bruno Teixeira", handle: "bruno.teixeira", bio: "Vendedor. A comissão varia, as contas não." },
  { key: "lari", name: "Larissa Pinto", handle: "lari.pinto", bio: "Social media. Vivo de prazo, agora com lembrete." },
  { key: "diego", name: "Diego Ramos", handle: "diego.ramos", bio: "Eletricista autônomo. Orçamento, obra e nota em dia." },
  { key: "nanda", name: "Fernanda Azevedo", handle: "nanda.azevedo", bio: "Enfermeira de plantão. Durmo quando dá, anoto sempre." },
];

/**
 * Posts das pessoas de exemplo. `h` = há quantas horas, contado da primeira vez que entram; `photo` = ilustração em
 * `assets/rede`. Post novo entra sempre no fim da lista (o número dele, `ex:post:N`, é o que impede repetir).
 */
export const EXAMPLE_POSTS: { who: string; h: number; body: string; photo?: string; comments: [string, string][] }[] = [
  {
    who: "carol",
    h: 5,
    body: "Três meses anotando tudo pelo áudio e descobri que eu gastava quase 300 reais por mês em delivery. Não cortei, mas agora escolho os dias.",
    comments: [["bia", "Delivery é o meu também. Dói ver o número."], ["fernando", "Escolher os dias é o segredo. Aqui é sexta e domingo."]],
  },
  {
    who: "rodrigo",
    h: 14,
    body: "Pra quem roda de app: mando \"abasteci 120\" no posto e no fim da semana sei exatamente quanto sobrou de verdade. Mudou meu jeito de ver o lucro.",
    comments: [["marcos", "Faturamento não é lucro. Lição que todo mundo devia aprender cedo."], ["edu", "Meu cunhado precisa ver isso."]],
  },
  {
    who: "ju",
    h: 26,
    body: "Semana de 14 encomendas de bolo. Se não fosse a agenda avisando cada entrega, eu tinha esquecido pelo menos duas.",
    comments: [["carol", "14! Você é uma máquina."], ["cidinha", "Faz bolo de fubá? Quero encomendar."], ["gabi", "Que orgulho de ver você crescendo."]],
  },
  {
    who: "marcos",
    h: 40,
    body: "Fiz a conta com meus alunos hoje: 200 reais por mês, a 1% ao mês, durante 10 anos, dá mais de 46 mil. Eles não acreditaram. Juros compostos são mágica lenta.",
    comments: [["bia", "Queria ter tido essa aula na escola."], ["luana", "Mágica lenta é a melhor definição que já li."], ["rodrigo", "Comecei com 100 por mês depois desse post."]],
  },
  {
    who: "bia",
    h: 52,
    body: "Primeira fatura do cartão que eu paguei inteira, sem parcelar. Pequena vitória, mas é minha.",
    comments: [["carol", "Pequena nada! Parabéns."], ["cidinha", "Muito bem, minha filha."], ["edu", "É assim que começa."]],
  },
  {
    who: "fernando",
    h: 67,
    body: "Lista de compras pelo WhatsApp foi a melhor coisa do ano aqui em casa. Acabou o \"você não comprou o leite?\".",
    comments: [["gabi", "Ri alto aqui porque é exatamente a minha casa."]],
  },
  {
    who: "luana",
    h: 80,
    body: "Freelancer sofre com mês que entra muito e mês que entra pouco. Comecei a me pagar um salário fixo e deixar o resto na reserva. Primeira vez que dezembro não me assusta.",
    comments: [["marcos", "Isso é gestão de caixa de empresa grande. Muito bom."], ["ju", "Vou copiar essa ideia para a confeitaria."]],
  },
  {
    who: "edu",
    h: 95,
    body: "Faltam quatro meses para a maratona e a meta da viagem já está em 62%. Ver a barrinha subir motiva mais que qualquer treino.",
    comments: [["rodrigo", "Bora! Manda foto da chegada."], ["bia", "Que inspiração."]],
  },
  {
    who: "cidinha",
    h: 110,
    body: "Minha neta me ensinou a mandar áudio pro Planejai. Agora ele me lembra dos remédios e da consulta. Não esqueço mais nada.",
    comments: [["carol", "Que lindo, dona Cida!"], ["fernando", "Vou ensinar minha mãe também."], ["gabi", "Essa neta merece um prêmio."]],
  },
  {
    who: "gabi",
    h: 128,
    body: "Primeira casa: fizemos a lista de tudo que falta e um limite por mês. Devagar ela vai ficando com a nossa cara, sem dívida.",
    comments: [["luana", "Devagar e sem dívida é o melhor jeito."], ["ju", "Quando tiver a cozinha pronta, me chama."]],
  },
  {
    who: "carol",
    h: 150,
    body: "Dica que funcionou aqui: um lembrete toda sexta às 18h, \"como foi a semana do dinheiro?\". Cinco minutos e eu já sei se dá pra pizza no sábado.",
    comments: [["edu", "Criei o meu agora."], ["marcos", "Revisão semanal é ouro."]],
  },
  {
    who: "marcos",
    h: 175,
    body: "Curiosidade para a aula de hoje: a palavra salário vem do latim salarium, ligada ao sal. Historiador discute se era pagamento mesmo, mas a origem da palavra é essa.",
    comments: [["cidinha", "Aprendi uma coisa nova hoje."], ["luana", "Adoro essas curiosidades."]],
  },
  // ---- leva de 2026-11-13: mais gente e posts com ilustração ----
  { who: "paula", h: 3, photo: "marmitas", body: "Marmitas da semana prontas: 10 potes, duas horas de domingo e zero delivery até sexta.", comments: [["caio", "É disso que eu falo para os alunos!"], ["carol", "Me ensina a ter essa disciplina."], ["vini", "Aceito doações."]] },
  { who: "caio", h: 6, photo: "treino", body: "Treino das 6h feito. O lembrete toca, eu reclamo, eu vou.", comments: [["edu", "O reclamar faz parte do aquecimento."], ["paula", "Orgulho!"]] },
  { who: "helena", h: 9, photo: "viagem", body: "Passagem do feriado comprada com o dinheiro da meta. Sem parcelar, sem culpa.", comments: [["renata", "Para onde? Quero copiar."], ["gabi", "Sem culpa é a melhor parte."]] },
  { who: "ju", h: 11, photo: "bolo", body: "Encomenda de hoje: bolo de aniversário de três andares. A agenda avisou cedo e deu tempo de caprichar.", comments: [["cidinha", "Que coisa mais linda!"], ["tati", "O da Alice vai ser com você."], ["carol", "Perfeito demais."]] },
  { who: "thiago", h: 13, photo: "mesa", body: "Home office arrumado. Descobri que organizar a mesa organiza a cabeça.", comments: [["luana", "A planta faz toda a diferença."], ["lari", "Agora falta organizar as abas do navegador."]] },
  { who: "tati", h: 16, photo: "cofrinho", body: "Mais um mês guardando para o salão. Já passei da metade!", comments: [["ju", "Vai dar certo, eu já sou cliente."], ["sandra", "Devagar e sempre, minha filha."], ["bruno", "Metade já é muita coisa."]] },
  { who: "rodrigo", h: 19, photo: "carro", body: "Tanque cheio e corridas anotadas. A semana fechou no azul.", comments: [["joao", "Tamo junto na rua."], ["marcos", "Azul é a cor mais bonita do extrato."]] },
  { who: "marina", h: 22, photo: "feira", body: "Domingo de feira. Lista feita no áudio, sacola cheia e nada esquecido.", comments: [["paula", "Feira é o melhor programa de domingo."], ["fernando", "Aqui a lista também é no áudio."]] },
  { who: "vini", h: 24, body: "Fechei o mês com 37 reais sobrando. Para um estagiário, isso é praticamente um investimento.", comments: [["marcos", "Todo patrimônio começa com 37 reais."], ["bia", "Estou no mesmo barco!"]] },
  { who: "jorge", h: 26, photo: "pesca", body: "Pescaria de sábado. O Planejai lembrou da isca, eu lembrei da paciência.", comments: [["cidinha", "E o peixe, lembrou de aparecer?"], ["diego", "Me chama na próxima, seu Jorge."]] },
  { who: "edu", h: 29, photo: "corrida", body: "21 km no domingo. Faltam três meses para a maratona.", comments: [["caio", "Ritmo bom. Não esquece do descanso."], ["helena", "Que inspiração!"], ["rodrigo", "Monstro."]] },
  { who: "isa", h: 33, photo: "gatos", body: "Dia de vacina dos três. Lembrete marcado há um ano, e eu achando que ia esquecer.", comments: [["thiago", "A Mel manda um latido de apoio."], ["nanda", "Vacina em dia é tudo."]] },
  { who: "sandra", h: 37, photo: "costura", body: "Ateliê cheio essa semana: seis barras, dois vestidos e uma cortina.", comments: [["gabi", "A cortina é a minha! Ansiosa."], ["tati", "Mão de fada."]] },
  { who: "lucas", h: 39, body: "Cliente que marca pelo WhatsApp e aparece no horário merece desconto. Ainda não dou, mas merece.", comments: [["bruno", "Eu sempre chego no horário, hein."], ["diego", "Vale para eletricista também."]] },
  { who: "vini", h: 41, photo: "jantar", body: "Jantar de república: 9 reais por pessoa. Engenharia aplicada.", comments: [["paula", "Faltou uma salada, mas aprovado."], ["fernando", "Manda a receita."]] },
  { who: "gabi", h: 45, photo: "sofa", body: "Chegou o sofá! Terceiro item da lista da casa, pago à vista.", comments: [["marina", "Ficou lindo com essa luminária."], ["ju", "Agora sim eu vou visitar."], ["luana", "À vista tem outro gosto."]] },
  { who: "renata", h: 50, photo: "prazos", body: "Café, agenda e três prazos para hoje. Vamos.", comments: [["lari", "Três? Amadora. (brincadeira, boa sorte)"], ["nanda", "Café primeiro, sempre."]] },
  { who: "lucas", h: 55, photo: "barbearia", body: "Agenda de sábado lotada. Quem marcou, marcou.", comments: [["thiago", "Consegui o último horário!"], ["joao", "Semana que vem eu apareço."]] },
  { who: "nanda", h: 58, body: "Plantão de 12 horas e nenhuma conta atrasada. O lembrete trabalha enquanto eu trabalho.", comments: [["bia", "Meu futuro. Obrigada por mostrar que dá."], ["isa", "Guerreira."]] },
  { who: "lari", h: 60, photo: "conteudo", body: "Planejei os posts do mês inteiro numa tarde. Sexta livre existe.", comments: [["luana", "Me conta esse segredo."], ["rafa", "Sexta livre? Nunca ouvi falar."]] },
  { who: "fernando", h: 66, photo: "pizza", body: "Pizza caseira de sábado. Sai por um terço do preço do delivery, e a bagunça é de graça.", comments: [["carol", "As crianças devem amar."], ["vini", "Um terço do preço? Estou anotando."], ["gabi", "Quero o convite."]] },
  { who: "nanda", h: 72, photo: "cafe", body: "Pós-plantão: café da manhã reforçado e a conta de luz já paga. Posso dormir em paz.", comments: [["paula", "Café da manhã de campeã."], ["cidinha", "Descansa, minha filha."]] },
  { who: "bruno", h: 75, body: "Regra nova aqui: comissão boa não é aumento de salário, é reserva. Demorei cinco anos para entender.", comments: [["luana", "Vale para freelancer também."], ["marcos", "Cinco anos bem investidos nessa lição."]] },
  { who: "joao", h: 78, photo: "moto", body: "Faltam quatro parcelas da moto. Cada entrega conta.", comments: [["rodrigo", "Já já é sua!"], ["tati", "Torcendo daqui."], ["edu", "Reta final."]] },
  { who: "cidinha", h: 84, photo: "jardim", body: "Meu jardim esse mês. A rega está no lembrete, as flores fazem o resto.", comments: [["jorge", "Capricho de sempre, dona Cida."], ["sandra", "Que girassol lindo."], ["isa", "Os gatos aqui iam destruir tudo."]] },
  { who: "bruno", h: 90, photo: "comissao", body: "Mês bom de comissão. Metade foi direto para a reserva, antes que eu mudasse de ideia.", comments: [["tati", "Antes de mudar de ideia é a parte importante."], ["marcos", "Parabéns pela disciplina."]] },
  { who: "diego", h: 97, photo: "obra", body: "Obra entregue no prazo e o orçamento bateu com o gasto. Coisa rara, tirei até foto.", comments: [["marina", "Preciso do seu contato para um projeto."], ["lucas", "Profissional assim está em falta."]] },
  { who: "rafa", h: 105, photo: "casamento", body: "Casamento de sábado entregue. Agora é só editar 1.400 fotos.", comments: [["lari", "Só. Força, guerreiro."], ["gabi", "As nossas ficaram lindas, obrigada de novo!"]] },
  { who: "bia", h: 112, photo: "provas", body: "Semana de provas. Cronograma no lembrete e café na mão.", comments: [["nanda", "Vai dar tudo certo. Depois me conta."], ["vini", "Semana de provas aqui também. Força."]] },
  { who: "carol", h: 120, photo: "festa", body: "Aniversário do Theo: festa em casa, orçamento respeitado e criança feliz.", comments: [["ju", "O bolo ficou do jeito que ele queria?"], ["fernando", "Festa em casa é a melhor."], ["tati", "Parabéns para o Theo!"]] },
  { who: "helena", h: 130, photo: "trilha", body: "Trilha do feriado. Zero sinal e zero preocupação com boleto: estava tudo agendado.", comments: [["edu", "Que vista!"], ["jorge", "No meu tempo era sem mapa."], ["renata", "Preciso de uma dessas."]] },
  { who: "marina", h: 135, body: "Cliente perguntou se reforma estoura o orçamento. Respondi que estoura quando ninguém anota. Depois que comecei a anotar as minhas contas, falo com propriedade.", comments: [["diego", "Assino embaixo."], ["gabi", "Estamos anotando tudo da nossa!"]] },
  { who: "paula", h: 140, photo: "saudavel", body: "Café da manhã de hoje. Comer bem não precisa custar caro.", comments: [["caio", "Mostra o preço que o pessoal não acredita."], ["bia", "Vou tentar essa semana."]] },
  { who: "luana", h: 150, photo: "paleta", body: "Paleta do projeto novo aprovada de primeira. Cliente feliz, boleto emitido.", comments: [["lari", "De primeira? Milagre."], ["marina", "Ficou elegante."]] },
  { who: "marcos", h: 160, photo: "aula", body: "Aula de hoje: porcentagem com cupom de mercado. Nunca vi a turma tão atenta.", comments: [["helena", "Vou roubar a ideia para a aula de inglês."], ["vini", "Queria ter tido esse professor."]] },
  { who: "thiago", h: 172, photo: "pet", body: "A Mel fez dois anos. Ração, vacina e brinquedo já têm linha própria no orçamento.", comments: [["isa", "Parabéns, Mel! Tutor responsável é outra coisa."], ["carol", "Que fofura."]] },
  { who: "tati", h: 185, photo: "unhas", body: "Unhas de hoje. A cliente saiu feliz e eu anotei o Pix antes de esquecer.", comments: [["lari", "Quero essa cor."], ["sandra", "Capricho!"]] },
  { who: "jorge", h: 192, body: "Dica de quem já errou muito: conta em débito automático também precisa de conferência. Uma vez por mês eu olho uma por uma.", comments: [["cidinha", "Faço igualzinho."], ["bruno", "Anotado, seu Jorge."]] },
  { who: "caio", h: 200, photo: "fit", body: "Marmita da semana feita junto com os alunos. Treino começa na cozinha.", comments: [["paula", "Parceria boa essa."], ["edu", "Qual é a de quarta?"]] },
  { who: "renata", h: 215, photo: "praia", body: "Praia no feriado prolongado, paga com o que sobrou do mês e não com o que falta do próximo.", comments: [["helena", "Essa frase vai para um quadro."], ["rafa", "Leva a câmera."]] },
  { who: "jorge", h: 230, photo: "contas", body: "Prestação de contas do condomínio fechada. Centavo por centavo.", comments: [["marcos", "Tesoureiro assim todo prédio quer."], ["diego", "Respeito."]] },
  { who: "isa", h: 245, photo: "reserva", body: "Reserva de emergência completa: seis meses. Demorou dois anos e valeu cada depósito.", comments: [["bruno", "Meta de vida."], ["luana", "Parabéns! Dois anos de constância."], ["nanda", "Que conquista."], ["marcos", "Isso é liberdade."]] },
  { who: "sandra", h: 260, body: "Minha neta disse que eu sou empreendedora. Eu disse que sou costureira com caderno organizado. Ela disse que é a mesma coisa.", comments: [["cidinha", "A neta está certa."], ["tati", "É a mesma coisa sim!"]] },
  { who: "diego", h: 275, body: "Orçamento mandado na hora fecha mais serviço do que orçamento perfeito mandado na semana seguinte.", comments: [["lucas", "Verdade em qualquer ramo."], ["rafa", "Aprendi isso perdendo cliente."]] },
];

/**
 * Destaques fixos (ficam no perfil; não passam na fileira de status do feed). `who` pode ser "planejai" (perfil oficial).
 * `d` = há quantos dias, contado da primeira vez que entram.
 */
export const EXAMPLE_HIGHLIGHTS: { who: string; d: number; body: string; bg?: string; photo?: string }[] = [
  { who: "planejai", d: 9, body: "Comece mandando um oi no WhatsApp", bg: "roxo" },
  { who: "planejai", d: 7, body: "Gastei 45 no mercado", bg: "noite" },
  { who: "planejai", d: 5, body: "Me lembra amanhã às 9h", bg: "mata" },
  { who: "planejai", d: 3, body: "Quanto gastei esse mês?", bg: "ceu" },
  { who: "paula", d: 8, body: "Marmitas", photo: "marmitas" },
  { who: "paula", d: 4, body: "Café da manhã", photo: "saudavel" },
  { who: "ju", d: 10, body: "Encomendas", photo: "bolo" },
  { who: "ju", d: 6, body: "Agenda cheia, graças a Deus", bg: "rosa" },
  { who: "helena", d: 12, body: "Viagens", photo: "viagem" },
  { who: "helena", d: 5, body: "Trilha", photo: "trilha" },
  { who: "caio", d: 7, body: "Treinos", photo: "treino" },
  { who: "edu", d: 6, body: "Maratona", photo: "corrida" },
  { who: "edu", d: 2, body: "62% da meta", bg: "sol" },
  { who: "cidinha", d: 9, body: "Jardim", photo: "jardim" },
  { who: "gabi", d: 8, body: "Casa nova", photo: "sofa" },
  { who: "tati", d: 5, body: "Meu salão", photo: "cofrinho" },
  { who: "thiago", d: 4, body: "Mel", photo: "pet" },
  { who: "isa", d: 3, body: "Reserva completa", photo: "reserva" },
  { who: "marcos", d: 11, body: "Juros compostos são mágica lenta", bg: "vinho" },
  { who: "rafa", d: 6, body: "Casamentos", photo: "casamento" },
];

/** Status do dia: todo dia sete da lista entram na fileira (cada um na sua hora) e somem em 24 horas. */
export const EXAMPLE_STATUS: { who: string; body: string; bg?: string; photo?: string }[] = [
  { who: "caio", body: "Bom dia! Treino feito antes das 7.", bg: "sol" },
  { who: "paula", body: "Hoje tem", photo: "saudavel" },
  { who: "ju", body: "Forno ligado desde cedo.", bg: "rosa" },
  { who: "rodrigo", body: "Trânsito parado, corridas anotadas.", bg: "tinta" },
  { who: "cidinha", body: "Reguei as plantas e tomei o remédio. Tudo em dia.", bg: "mata" },
  { who: "lari", body: "Sextou? Ainda não. Mas o lembrete já avisou.", bg: "magenta" },
  { who: "edu", body: "Longão de domingo", photo: "corrida" },
  { who: "marcos", body: "Pergunta do dia: 10% de desconto e depois 10% de aumento volta ao mesmo preço?", bg: "noite" },
  { who: "helena", body: "Contando os dias para o feriado.", bg: "ceu" },
  { who: "tati", body: "Agenda de hoje cheia!", bg: "lilas" },
  { who: "thiago", body: "A Mel pediu passeio", photo: "pet" },
  { who: "nanda", body: "Plantão. Café na mão e bora.", bg: "mar" },
  { who: "gabi", body: "Dia de montar estante.", bg: "areia" },
  { who: "joao", body: "Chuva na cidade, capa na mochila.", bg: "tinta" },
  { who: "fernando", body: "Sábado é dia de", photo: "pizza" },
  { who: "bia", body: "Estudando para a prova de amanhã.", bg: "roxo" },
  { who: "lucas", body: "Dois horários livres hoje à tarde.", bg: "noite" },
  { who: "isa", body: "Paciente do dia", photo: "gatos" },
  { who: "carol", body: "Fechamento do mês. Rezem por mim.", bg: "vinho" },
  { who: "sandra", body: "Máquina funcionando desde as 6.", bg: "rosa" },
  { who: "renata", body: "Audiência às 14h. Lembrete às 13h.", bg: "tinta" },
  { who: "vini", body: "Almoço de hoje", photo: "jantar" },
  { who: "jorge", body: "Rio cheio, vara pronta.", bg: "mar" },
  { who: "luana", body: "Cliente aprovou!", bg: "lilas" },
  { who: "marina", body: "Visita de obra cedo.", bg: "areia" },
  { who: "diego", body: "Serviço entregue.", photo: "obra" },
  { who: "bruno", body: "Meta da semana batida na quinta.", bg: "mata" },
  { who: "rafa", body: "Editando", photo: "casamento" },
];

/** Comentários dos posts de partida do @planejai, pelo número do post (seed:N em feed-oficial.ts). */
export const SEED_COMMENTS: Record<number, [string, string][]> = {
  1: [["carol", "Que legal ter um lugar assim. Bora trocar dicas!"], ["cidinha", "Cheguei! Ainda aprendendo, mas gostei muito."], ["rodrigo", "Finalmente um lugar para mostrar quando dá certo."]],
  2: [["marcos", "Matemática pura."], ["bia", "Doeu, mas é verdade."]],
  3: [["rodrigo", "Uso todo dia no posto, é muito rápido."], ["luana", "Achei que ia ter que escolher a categoria. Ele acerta quase sempre."]],
  4: [["carol", "Pedi para lembrar da vacina do Theo."], ["fernando", "Lista do mercado, claro."], ["cidinha", "Lembrar do remédio da pressão."], ["ju", "A agenda das encomendas."]],
  5: [["luana", "Vou colar isso na parede."]],
  6: [["gabi", "Fiz com todas as contas da casa nova. Salvou!"], ["edu", "Não pago mais multa da internet."]],
  7: [["ju", "Faço isso toda noite antes de dormir."]],
  9: [["cidinha", "É o que eu mais uso. Não sei digitar rápido."], ["rodrigo", "No trânsito é o único jeito."]],
  10: [["bia", "Essa pergunta me salvou esse mês."]],
  11: [["marcos", "Cafezinho de todo dia que o diga."]],
  12: [["luana", "Era o que faltava para mim, recebo dia 20."], ["marcos", "Recebo dia 5 e ficou muito melhor de acompanhar."]],
  13: [["fernando", "Testei com a nota do mercado e leu tudo certinho."]],
  15: [["fernando", "Melhor recurso."], ["gabi", "Agora não esqueço mais nada no mercado."]],
  16: [["edu", "Foi assim que montei a meta da maratona."]],
  19: [["carol", "Delivery. Sempre delivery."], ["bia", "Uber, aparentemente."]],
  21: [["luana", "Importei três meses de extrato e não duplicou nada."]],
  22: [["ju", "Pedi uma receita para o almoço de domingo e veio certinho."]],
  26: [["cidinha", "Isso me deixou mais tranquila."], ["marcos", "Importante demais."]],
  28: [["gabi", "Mandei para o meu marido na hora."]],
  31: [["edu", "Fiz o teste e assustei."], ["carol", "Prefiro nem saber. Mentira, vou fazer agora."]],
  34: [["rodrigo", "Comecei com 50 por semana."]],
  37: [["bia", "Eu precisava ler isso hoje."]],
};

/** Comentários que servem para qualquer post (pauta, blog, status do WhatsApp). */
const GENERIC = [
  "Salvei aqui para não esquecer.",
  "Muito bom, valeu pela dica.",
  "Não sabia disso.",
  "Mandei para o grupo da família.",
  "Faz todo sentido.",
  "Preciso começar a fazer isso.",
  "Verdade demais.",
  "Boa! Vou testar essa semana.",
  "Isso eu levo pra vida.",
  "Que dica boa.",
  "Anotado.",
  "Esse tipo de post ajuda muito.",
];

/** Número estável a partir de um texto (a mesma pessoa curte o mesmo post em toda rodada). */
export function hashOf(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Cria (uma vez) as pessoas de exemplo; devolve chave -> user_id. Quem tiver o @ ocupado por gente de verdade fica de fora. */
async function ensurePeople(official: string) {
  const ids = new Map<string, string>();
  for (const p of PEOPLE) {
    const phone = `${EXAMPLE_PREFIX}${p.key}`;
    let u = await one<{ id: string }>("SELECT id FROM users WHERE phone = $1", [phone]);
    if (!u) u = await one<{ id: string }>("INSERT INTO users (phone, name, status) VALUES ($1, $2, 'blocked') ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone RETURNING id", [phone, p.name]);
    const id = u!.id;
    const prof = await one<{ user_id: string }>("SELECT user_id FROM feed_profiles WHERE user_id = $1", [id]);
    if (!prof) {
      const taken = await one("SELECT 1 FROM feed_profiles WHERE lower(handle) = lower($1)", [p.handle]);
      if (taken) continue;
      await query("INSERT INTO feed_profiles (user_id, handle, name, bio) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [id, p.handle, p.name, p.bio]);
      await query("INSERT INTO feed_follows (follower_id, followed_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, official]);
    }
    ids.set(p.key, id);
  }
  // cada um segue alguns dos outros (sempre os mesmos)
  const keys = [...ids.keys()];
  for (const [i, k] of keys.entries())
    for (const step of [1, 3, 4, 7, 11]) {
      const other = keys[(i + step) % keys.length]!;
      if (other !== k) await query("INSERT INTO feed_follows (follower_id, followed_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [ids.get(k), ids.get(other)]);
    }
  return ids;
}

async function ensurePosts(ids: Map<string, string>, now: Date) {
  let n = 0;
  for (const [i, p] of EXAMPLE_POSTS.entries()) {
    const who = ids.get(p.who);
    if (!who) continue;
    const row = await one<{ id: string }>(
      `INSERT INTO feed_posts (user_id, body, source, created_at) VALUES ($1, $2, $3, $4::timestamptz - make_interval(hours => $5) - make_interval(mins => $6))
       ON CONFLICT (source) WHERE source IS NOT NULL DO NOTHING RETURNING id`,
      [who, p.body, `ex:post:${i + 1}`, now, p.h, (i * 23) % 50],
    );
    if (!row) continue;
    n++;
    const data = p.photo ? art(p.photo) : null;
    if (data) await attachServerPhoto({ post_id: row.id }, data).catch(() => {});
  }
  return n;
}

/** Um status de exemplo (do dia ou destaque); `source` impede repetir. A foto que falhar derruba o status. */
async function addStatus(who: string, it: { body: string; bg?: string; photo?: string }, source: string, at: Date, highlight: boolean) {
  const data = it.photo ? art(it.photo) : null;
  if (it.photo && !data) return 0;
  const st = await one<{ id: string }>(
    `INSERT INTO feed_status (user_id, kind, body, bg, source, created_at, expires_at, highlighted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + interval '24 hours', CASE WHEN $7 THEN $6::timestamptz END)
     ON CONFLICT (source) WHERE source IS NOT NULL DO NOTHING RETURNING id`,
    [who, data ? "photo" : "text", it.body, it.bg ?? "tinta", source, at, highlight],
  );
  if (!st) return 0;
  if (data) {
    try {
      await attachServerPhoto({ status_id: st.id }, data);
    } catch {
      await query("DELETE FROM feed_status WHERE id = $1", [st.id]);
      return 0;
    }
  }
  return 1;
}

/** Destaques fixos dos perfis de exemplo e do @planejai. */
async function ensureHighlights(official: string, ids: Map<string, string>, now: Date) {
  let n = 0;
  for (const [i, h] of EXAMPLE_HIGHLIGHTS.entries()) {
    const who = h.who === "planejai" ? official : ids.get(h.who);
    if (who) n += await addStatus(who, h, `ex:hl:${i + 1}`, new Date(now.getTime() - h.d * 86_400_000 - (i % 7) * 3_600_000), true);
  }
  return n;
}

const STATUS_PER_DAY = 7;
/** Status do dia: sete da lista por dia (a lista gira), cada um numa hora entre 7h e 21h de Brasília; só entra o que já passou. */
async function ensureDailyStatus(ids: Map<string, string>, now: Date) {
  let n = 0;
  const BRT = 3 * 3_600_000;
  const today = Math.floor((now.getTime() - BRT) / 86_400_000);
  for (const day of [today - 1, today]) {
    for (let k = 0; k < STATUS_PER_DAY; k++) {
      const it = EXAMPLE_STATUS[(((day * STATUS_PER_DAY + k) % EXAMPLE_STATUS.length) + EXAMPLE_STATUS.length) % EXAMPLE_STATUS.length]!;
      const who = ids.get(it.who);
      const at = new Date(day * 86_400_000 + BRT + (7 + k * 2) * 3_600_000 + ((day * 13 + k * 17) % 50) * 60_000);
      if (!who || at > now || at.getTime() + 86_400_000 <= now.getTime()) continue;
      n += await addStatus(who, it, `ex:st:${day}:${k}`, at, false);
    }
  }
  return n;
}

/** Comentários previstos para um post: os escritos para ele ou, nos da pauta/blog/status, até dois genéricos. */
function commentsFor(source: string, h: number): [string | null, string][] {
  const ex = /^ex:post:(\d+)$/.exec(source);
  if (ex) return EXAMPLE_POSTS[Number(ex[1]) - 1]?.comments ?? [];
  const seed = /^seed:(\d+)$/.exec(source);
  if (seed) return SEED_COMMENTS[Number(seed[1])] ?? [];
  const k = h % 3; // 0, 1 ou 2 comentários
  return Array.from({ length: k }, (_, i) => [null, GENERIC[(h + i * 5) % GENERIC.length]!] as [null, string]);
}

/**
 * Curtidas e comentários das pessoas de exemplo nos posts do @planejai e nos delas. Roda de hora em hora: o que já
 * chegou na hora entra, o resto fica para a próxima rodada. Só olha post novo (3 dias) ou que ainda não tem nada.
 */
async function engage(official: string, ids: Map<string, string>, now: Date) {
  if (!ids.size) return { likes: 0, comments: 0 };
  const people = [...ids.entries()];
  const exampleIds = people.map(([, id]) => id);
  const posts = await many<{ id: string; user_id: string; source: string; created_at: Date }>(
    `SELECT p.id, p.user_id, p.source, p.created_at FROM feed_posts p
      WHERE p.source IS NOT NULL AND (p.user_id = $1 OR p.user_id = ANY($2)) AND p.created_at <= $3
        AND p.created_at > $3::timestamptz - interval '60 days'
        AND (p.created_at > $3::timestamptz - interval '3 days'
             OR NOT EXISTS (SELECT 1 FROM feed_likes l WHERE l.post_id = p.id AND l.user_id = ANY($2)))`,
    [official, exampleIds, now],
  );
  let likes = 0;
  let comments = 0;
  for (const p of posts) {
    const h = hashOf(p.source);
    const born = new Date(p.created_at).getTime();
    // curtidas: de 4 a 18 pessoas (o de boas-vindas, todas), uma a cada tantos minutos depois do post
    const want = p.source === "seed:1" ? people.length : 4 + (h % 15);
    const likers: string[] = [];
    const at: Date[] = [];
    for (let k = 0; k < Math.min(want, people.length); k++) {
      const [, uid] = people[(h + k * 3) % people.length]!;
      if (uid === p.user_id || likers.includes(uid)) continue;
      const when = born + (k + 1) * (12 + (h % 35)) * 60_000;
      if (when > now.getTime()) break;
      likers.push(uid);
      at.push(new Date(when));
    }
    if (likers.length) {
      const r = await query(
        "INSERT INTO feed_likes (post_id, user_id, created_at) SELECT $1, u, t FROM unnest($2::uuid[], $3::timestamptz[]) AS x(u, t) ON CONFLICT DO NOTHING",
        [p.id, likers, at],
      );
      likes += r.rowCount ?? 0;
    }
    // comentários
    for (const [k, [who, body]] of commentsFor(p.source, h).entries()) {
      const uid = who ? ids.get(who) : people[(h + 7 + k * 4) % people.length]![1];
      if (!uid || uid === p.user_id) continue;
      const when = born + (25 + k * 50 + (h % 40)) * 60_000;
      if (when > now.getTime()) continue;
      const r = await query(
        `INSERT INTO feed_comments (post_id, user_id, body, created_at, source) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (source) WHERE source IS NOT NULL DO NOTHING`,
        [p.id, uid, body, new Date(when), `ex:c:${p.source}:${k}`],
      );
      comments += r.rowCount ?? 0;
    }
  }
  return { likes, comments };
}

/** Pessoas, posts, destaques, status do dia, curtidas e comentários de exemplo. Pode rodar quantas vezes quiser. */
export async function syncExampleCrowd(official: string, now = new Date()) {
  const ids = await ensurePeople(official);
  const posts = await ensurePosts(ids, now);
  const highlights = await ensureHighlights(official, ids, now);
  const status = await ensureDailyStatus(ids, now);
  const { likes, comments } = await engage(official, ids, now);
  return { people: ids.size, posts, highlights, status, likes, comments };
}
