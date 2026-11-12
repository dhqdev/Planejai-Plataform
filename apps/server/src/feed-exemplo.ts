import { many, one, query } from "./db/pool.js";

/**
 * Pessoas de exemplo da rede: dez perfis com nome, bio e alguns posts, que curtem e comentam os posts do @planejai
 * (os de partida, os da pauta, os do blog e os do status do WhatsApp) e uns dos outros, para o feed não parecer vazio.
 * Pedido do David (2026-11-12). Sem IA: os comentários são texto pronto.
 *
 * Cada pessoa é um registro em `users` com telefone "planejai-ex-<chave>" e status "blocked" (não recebe mensagem,
 * não entra em rotina nenhuma e fica fora da lista de Pessoas). Curtidas e comentários chegam aos poucos, com a hora
 * de cada um alguns minutos depois do post, e nunca no futuro; `feed_comments.source` impede repetir.
 * Não mexem em post de gente de verdade.
 */

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
];

/** Posts das pessoas de exemplo. `h` = há quantas horas, contado da primeira vez que entram. */
export const EXAMPLE_POSTS: { who: string; h: number; body: string; comments: [string, string][] }[] = [
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
  // cada um segue três dos outros (sempre os mesmos)
  const keys = [...ids.keys()];
  for (const [i, k] of keys.entries())
    for (const step of [1, 3, 4]) {
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
    const r = await query(
      `INSERT INTO feed_posts (user_id, body, source, created_at) VALUES ($1, $2, $3, $4::timestamptz - make_interval(hours => $5) - make_interval(mins => $6))
       ON CONFLICT (source) WHERE source IS NOT NULL DO NOTHING`,
      [who, p.body, `ex:post:${i + 1}`, now, p.h, (i * 23) % 50],
    );
    n += r.rowCount ?? 0;
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
    // curtidas: de 3 a 9 pessoas (o de boas-vindas, todas), uma a cada tantos minutos depois do post
    const want = p.source === "seed:1" ? people.length : 3 + (h % 7);
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

/** Pessoas, posts, curtidas e comentários de exemplo. Pode rodar quantas vezes quiser. */
export async function syncExampleCrowd(official: string, now = new Date()) {
  const ids = await ensurePeople(official);
  const posts = await ensurePosts(ids, now);
  const { likes, comments } = await engage(official, ids, now);
  return { people: ids.size, posts, likes, comments };
}
