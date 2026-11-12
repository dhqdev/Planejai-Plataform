import { config } from "./config.js";
import { many, one, query } from "./db/pool.js";
import { tzOffsetMs } from "./time.js";

/**
 * Pauta do perfil oficial (@planejai): um post por dia sobre finanças, calendário, curiosidades e novidades do app.
 * Texto pronto, sem IA e sem grão (pouco token). Os de época (`months`) saem primeiro no mês certo, uma vez por ano;
 * o resto gira pelo que ficou mais tempo sem sair. Chamado por `syncOfficialFeed` (feed-oficial.ts) de hora em hora.
 * Para ampliar: acrescente itens com `id` novo (nunca reaproveite um id, ele marca o que já saiu).
 */

export interface PautaItem {
  id: string;
  body: string;
  /** frase grande sobre cor (feed-oficial.ts CARD_BGS) */
  card?: "noite" | "lilas" | "tinta" | "roxo" | "areia" | "mata";
  /** meses (1 a 12) em que o post é da época */
  months?: number[];
}

export const PAUTA: PautaItem[] = [
  // ---------- finanças ----------
  { id: "fin-reserva", body: "Reserva de emergência: o ideal é juntar de 3 a 6 meses do seu custo de vida, num lugar que dá para sacar no mesmo dia. Ela é o que transforma um imprevisto em só um susto." },
  { id: "fin-503020", body: "A regra 50/30/20 é um bom ponto de partida: 50% da renda para o essencial, 30% para o que você gosta e 20% para guardar ou pagar dívida. Não precisa ser exato, precisa ser um norte." },
  { id: "fin-juros", card: "noite", body: "Juros compostos trabalham dos dois lados: a favor de quem investe, contra quem deve." },
  { id: "fin-rotativo", body: "O rotativo do cartão está entre os juros mais caros do país. Se a fatura não fecha, o parcelamento da fatura ou um empréstimo mais barato quase sempre sai melhor do que pagar o mínimo." },
  { id: "fin-poupanca", body: "Curiosidade de bolso: com a Selic acima de 8,5% ao ano, a poupança rende 0,5% ao mês mais a TR. Vale comparar com opções atreladas ao CDI antes de deixar o dinheiro parado." },
  { id: "fin-inflacao", body: "Inflação é o aumento geral dos preços. Na prática: o mesmo dinheiro compra menos com o tempo. Por isso guardar sem render é, devagar, perder." },
  { id: "fin-assinaturas", card: "areia", body: "Faça a conta das assinaturas uma vez por ano. Tem sempre uma que você esqueceu que paga." },
  { id: "fin-24h", body: "Truque das 24 horas: viu algo que quer comprar e não estava nos planos? Espera um dia. Se a vontade continuar, compra sem culpa. Muita compra por impulso some sozinha." },
  { id: "fin-fatura", body: "Melhor dia de compra no cartão é logo depois do fechamento da fatura: você ganha quase 40 dias até pagar. Vale saber a data do seu." },
  { id: "fin-metas", card: "roxo", body: "Guardar fica mais fácil quando o dinheiro tem nome: viagem, carro, reserva." },
  { id: "fin-cafe", body: "Gasto pequeno do dia a dia parece nada, mas soma. Um café de 8 reais em 22 dias úteis vira 176 reais no mês. Não é para cortar o café, é para escolher com os olhos abertos." },
  { id: "fin-pix", body: "Pix agendado ajuda a não esquecer conta e a separar o dinheiro antes de gastar. Programe a transferência para a reserva no dia em que o salário cai." },
  // ---------- organização e rotina ----------
  { id: "org-2min", body: "Regra dos 2 minutos: se a tarefa leva menos de dois minutos, faça agora. O resto vai para a lista com dia e hora." },
  { id: "org-pomodoro", body: "Pomodoro: 25 minutos de foco, 5 de pausa, e a cada quatro rodadas uma pausa maior. Criado pelo italiano Francesco Cirillo no fim dos anos 80, com um timer de cozinha em forma de tomate." },
  { id: "org-semana", card: "mata", body: "Uma semana planejada no domingo vale por duas improvisadas." },
  { id: "org-tres", body: "Escolha só três prioridades para amanhã antes de dormir. Lista enorme cansa antes de começar; três coisas cabem no dia." },
  { id: "org-sono", card: "lilas", body: "Dormir bem também é produtividade." },
  // ---------- curiosidades ----------
  { id: "cur-zeigarnik", body: "Efeito Zeigarnik: a gente lembra mais das tarefas inacabadas do que das concluídas, e elas ficam ocupando a cabeça. Anotar tira esse peso: o cérebro entende que está guardado em outro lugar." },
  { id: "cur-ebbinghaus", body: "A curva do esquecimento, estudada por Hermann Ebbinghaus no século 19, mostra que boa parte do que aprendemos some em poucos dias se não for revisada. Lembrete na hora certa ajuda a memória." },
  { id: "cur-real", body: "O Real entrou em circulação em 1º de julho de 1994 e acabou com anos de inflação descontrolada. Teve época em que os preços mudavam de um dia para o outro no mercado." },
  { id: "cur-lobo", body: "A nota de 200 reais, lançada em 2020, traz o lobo-guará, um animal típico do Cerrado. É a única cédula do Real com esse bicho." },
  { id: "cur-bissexto", body: "Ano bissexto acontece a cada 4 anos para acertar o calendário com o tempo que a Terra leva para dar a volta no Sol. Mas há exceção: anos que fecham século só são bissextos se forem divisíveis por 400." },
  { id: "cur-calendario", body: "O calendário que usamos é o gregoriano, adotado em 1582. Na mudança, alguns países pularam 10 dias de uma vez: do dia 4 de outubro foram direto para o dia 15." },
  { id: "cur-segunda", card: "tinta", body: "Segunda-feira tem fama ruim, mas é o dia em que mais gente começa um hábito novo." },
  // ---------- calendário (época) ----------
  { id: "cal-ano-novo", months: [1], body: "Começo de ano é bom para revisar as contas fixas: aluguel, escola, plano de saúde e assinaturas costumam reajustar agora. Cadastre tudo no Planejai e receba o aviso antes de cada vencimento." },
  { id: "cal-ipva", months: [1, 2], body: "Janeiro é mês de IPVA e IPTU em boa parte do país. Pagar à vista costuma ter desconto; se não der, parcelar sem atraso evita multa. Peça para o Planejai lembrar das datas." },
  { id: "cal-aulas", months: [1, 2], body: "Volta às aulas pesa no bolso: material, uniforme e matrícula. Pesquise preço, aproveite o que sobrou do ano passado e anote cada gasto para saber quanto custou de verdade." },
  { id: "cal-carnaval", months: [2, 3], card: "roxo", body: "Carnaval bom é o que não aparece na fatura de março." },
  { id: "cal-ir", months: [3, 4, 5], body: "Época de declarar o Imposto de Renda, que costuma ir de março a maio. Separe informes de rendimento, recibos de saúde e de educação. Quem entrega cedo também costuma receber a restituição antes." },
  { id: "cal-maes", months: [5], body: "Dia das Mães é no segundo domingo de maio. Peça para o Planejai lembrar uns dias antes e definir quanto quer gastar no presente. Carinho não precisa de parcela." },
  { id: "cal-ferias-julho", months: [6, 7], body: "Férias de julho chegando: viagem planejada com antecedência sai mais barata. Monte a lista da mala e o orçamento da viagem pelo WhatsApp e acompanhe os gastos de cada dia." },
  { id: "cal-pais", months: [8], body: "Dia dos Pais é no segundo domingo de agosto. Ainda dá tempo de pedir um lembrete e combinar o presente sem correria." },
  { id: "cal-primavera", months: [9], card: "areia", body: "Primavera chegando: bom momento para dar uma faxina na agenda também." },
  { id: "cal-criancas", months: [10], body: "Dia das Crianças é 12 de outubro. Um limite de gasto definido antes de entrar na loja evita aquele presente que custou o dobro do planejado." },
  { id: "cal-13", months: [11, 12], body: "O 13º salário sai em duas parcelas: a primeira até 30 de novembro e a segunda até 20 de dezembro. Antes de gastar, vale separar uma parte para as contas de janeiro, que sempre chegam." },
  { id: "cal-black", months: [11], body: "Black Friday é na última sexta de novembro. Dica: anote hoje o preço do que você quer e compare no dia. Desconto de verdade aparece; o \"metade do dobro\" também." },
  { id: "cal-natal", months: [12], body: "Lista de presentes de Natal com valor por pessoa ajuda a não estourar o orçamento. Dá para montar a lista no WhatsApp e ir riscando conforme compra." },
  { id: "cal-metas-ano", months: [12, 1], card: "noite", body: "Meta de ano novo funciona melhor quando cabe numa frase e tem uma data." },
  // ---------- novidades e funções do Planejai ----------
  { id: "app-agendamento", body: "Novidade para quem atende clientes: o link de agendamento. Você escolhe os horários, coloca o link na bio do Instagram e as pessoas marcam sozinhas. Fica na Agenda." },
  { id: "app-mes", body: "Seu mês financeiro pode começar no dia em que o salário cai. Os gráficos, os limites e o resumo passam a seguir o seu mês de verdade. Em Finanças, \"Mudar o dia\"." },
  { id: "app-ofx", body: "Dá para importar o extrato do banco (arquivo OFX) em Finanças. O Planejai confere, separa por categoria e não duplica o que você já tinha lançado." },
  { id: "app-compras", body: "Antes de comprar, pergunte \"quanto está custando uma air fryer\". O Planejai busca o preço em lojas e você pode pedir para ficar de olho até baixar." },
  { id: "app-audio", card: "lilas", body: "Pode mandar áudio. O Planejai entende do seu jeito." },
  { id: "app-limite", body: "Defina um limite por categoria em Finanças, como mercado ou delivery. Quando chegar perto, o Planejai avisa no WhatsApp antes de passar." },
  { id: "app-lembrete-recorrente", body: "Lembrete que se repete: \"me lembra de tomar o remédio todo dia às 8h\" ou \"toda segunda de levar o lixo\". Uma mensagem e ele cuida do resto." },
];

/** Data e hora locais da stack (fuso padrão). */
function local(now: Date) {
  const d = new Date(now.getTime() + tzOffsetMs(now, config.DEFAULT_TIMEZONE));
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), month: d.getUTCMonth() + 1 };
}

/** Escolhe o próximo: o de época ainda não usado nos últimos 300 dias vem antes; depois o que está há mais tempo sem sair. */
export function nextPauta(used: { id: string; at: Date }[], month: number, now: Date, items = PAUTA) {
  const last = new Map<string, number>();
  for (const u of used) last.set(u.id, Math.max(last.get(u.id) ?? 0, u.at.getTime()));
  const fresh = (p: PautaItem) => now.getTime() - (last.get(p.id) ?? 0) > 300 * 86_400_000;
  const pool = items.filter((p) => !p.months || p.months.includes(month));
  const rank = (p: PautaItem) => (p.months && fresh(p) ? 0 : 1);
  return [...pool].sort((a, b) => rank(a) - rank(b) || (last.get(a.id) ?? 0) - (last.get(b.id) ?? 0))[0] ?? null;
}

/** Um post da pauta por dia, a partir das 11h (hora local). Devolve 1 se postou. */
export async function postPauta(official: string, now = new Date()) {
  const { day, hour, month } = local(now);
  if (hour < 11 || hour > 21) return 0;
  if (await one("SELECT 1 FROM feed_posts WHERE source LIKE 'pauta:%' AND source LIKE $1 LIMIT 1", [`%:${day}`])) return 0;
  const rows = await many<{ source: string; created_at: Date }>("SELECT source, created_at FROM feed_posts WHERE source LIKE 'pauta:%'");
  const used = rows.map((r) => ({ id: r.source.split(":")[1] ?? "", at: new Date(r.created_at) }));
  const pick = nextPauta(used, month, now);
  if (!pick) return 0;
  const r = await query(
    `INSERT INTO feed_posts (user_id, body, card, source, created_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source) WHERE source IS NOT NULL DO NOTHING`,
    [official, pick.body, pick.card ?? null, `pauta:${pick.id}:${day}`, now],
  );
  return r.rowCount ?? 0;
}
