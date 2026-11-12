import { config } from "./config.js";
import { many, one, query } from "./db/pool.js";
import { attachServerPhoto } from "./feed.js";

/**
 * Perfil oficial do Planejai na rede social (@planejai, com selo). Ele posta sozinho, sem IA e sem grão:
 * - uns posts de partida (SEED), uma vez só, espalhados nas últimas semanas para o feed não nascer vazio;
 * - cada post do blog publicado com capa vira um cartão de link;
 * - cada status do WhatsApp com cena do Bolinho vira post com a foto e, nas primeiras 24 h, status da rede também.
 * `source` em feed_posts/feed_status impede repetir. Roda na limpeza de hora em hora, ao subir o worker
 * e logo depois de um status do WhatsApp sair (wa-status.ts).
 *
 * A pessoa por trás do perfil é um registro em `users` com telefone "planejai" e status "blocked": não recebe
 * mensagem, não entra em nenhuma rotina de cliente e fica fora da lista de Pessoas (como o "playground").
 */

export const OFFICIAL_PHONE = "planejai";
export const OFFICIAL_HANDLE = "planejai";
const OFFICIAL_BIO = "Seu time de bolso no WhatsApp. Dicas de organização, novidades do app e os posts do blog.";

/** Cores dos posts em cartão (as cores moram no CSS do painel). */
export const CARD_BGS = ["noite", "lilas", "tinta", "roxo", "areia", "mata"] as const;

/** Posts de partida. `h` = há quantas horas foi "publicado" (o mais novo primeiro no feed). */
export const SEED: { body: string; card?: (typeof CARD_BGS)[number]; h: number }[] = [
  {
    h: 2,
    body:
      "Bem-vindo ao Feed do Planejai.\n\nAqui é o lugar de quem usa o Planejai trocar ideias, mostrar conquistas e dividir o que funciona na rotina. Publique, comente e siga quem te inspira.",
  },
  { h: 9, card: "noite", body: "Quem anota, lembra. Quem lembra, não paga juros." },
  { h: 20, body: "Dica rápida: manda no WhatsApp \"gastei 45 no almoço\" e pronto. O gasto já aparece em Finanças, na categoria certa, sem abrir planilha nenhuma." },
  { h: 31, body: "Conta pra gente nos comentários: qual foi a primeira coisa que você pediu para o Planejai?" },
  { h: 44, card: "lilas", body: "Organizar não é ter tempo sobrando. É saber para onde ele está indo." },
  { h: 57, body: "Sabia que dá para pedir \"me lembra de pagar a luz todo dia 10\"? O lembrete se repete sozinho, todo mês, e chega antes da pressa." },
  { h: 70, body: "Agenda cheia? Manda \"o que eu tenho amanhã\" e recebe o dia inteiro organizado em uma mensagem só." },
  { h: 83, card: "tinta", body: "Um áudio de 10 segundos no WhatsApp vale mais que três aplicativos abertos." },
  { h: 98, body: "Áudio também vale. Fala do seu jeito, com pressa, no trânsito, no meio da cozinha. O Planejai entende e anota." },
  { h: 113, body: "Fatura do cartão chegando? Pergunte \"quanto já gastei no cartão este mês\" e veja o número antes da surpresa." },
  { h: 126, card: "areia", body: "Gasto pequeno não existe. Existe gasto que ninguém anotou." },
  { h: 141, body: "Recebe no dia 5? Você pode começar o mês financeiro no dia 5. Os gráficos, os limites e o resumo passam a seguir o seu mês de verdade. Fica em Finanças, embaixo do calendário, em \"Mudar o dia\"." },
  { h: 158, body: "Manda uma foto do comprovante e o Planejai lê o valor, o lugar e a data, e lança o gasto para você." },
  { h: 172, card: "roxo", body: "Seu dinheiro conta uma história todo mês. Vale a pena ler." },
  { h: 189, body: "Lista de compras sem papel: \"coloca leite, café e pão na lista\". Ela fica pronta na tela Compras e você marca no mercado." },
  { h: 205, body: "Metas com prazo funcionam melhor. Tenta assim: \"quero juntar 3 mil para a viagem até julho\". O Planejai calcula quanto guardar por mês e acompanha com você." },
  { h: 220, card: "mata", body: "Domingo à noite: cinco minutos olhando a semana poupam cinco dias correndo atrás." },
  { h: 236, body: "Contas fixas no automático: cadastre aluguel, internet e academia uma vez e receba o aviso antes de cada vencimento." },
  { h: 251, body: "Pergunta que vale ouro no fim do mês: \"onde eu mais gastei?\". A resposta quase sempre surpreende." },
  { h: 268, card: "noite", body: "Lembrete bom é aquele que chega antes da pressa." },
  { h: 284, body: "Baixou o extrato do banco em OFX? Importa em Finanças: o Planejai confere, separa por categoria e não duplica o que você já tinha lançado." },
  { h: 301, body: "O Planejai não trabalha sozinho. Tem especialista em dinheiro, agenda, compras, viagem e até receita. Você pede no WhatsApp e o Juvenal chama quem entende do assunto." },
  { h: 318, card: "lilas", body: "Meta sem data é só vontade." },
  { h: 336, body: "Status por aqui também: uma foto ou uma frase que some em 24 horas. Toque no + do seu avatar, lá em cima do feed." },
  { h: 355, card: "areia", body: "Lista feita em casa economiza no mercado." },
  { h: 372, body: "Privacidade em primeiro lugar: sua agenda, seus gastos e seu número nunca aparecem aqui. No Feed só aparece o que você mesmo publicar." },
  { h: 390, card: "tinta", body: "Menos abas abertas, mais cabeça livre." },
];

/** Cria (uma vez) a pessoa e o perfil oficial. Devolve o id. */
export async function ensureOfficial() {
  let u = await one<{ id: string }>("SELECT id FROM users WHERE phone = $1", [OFFICIAL_PHONE]);
  if (!u)
    u = await one<{ id: string }>(
      "INSERT INTO users (phone, name, status) VALUES ($1, 'Planejai', 'blocked') ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone RETURNING id",
      [OFFICIAL_PHONE],
    );
  const id = u!.id;
  // o @planejai é reservado no cadastro; se alguém já tinha esse @ antes da reserva, o oficial fica com outro
  const taken = await one<{ user_id: string }>("SELECT user_id FROM feed_profiles WHERE lower(handle) = $1", [OFFICIAL_HANDLE]);
  const handle = taken && taken.user_id !== id ? "planejai.oficial" : OFFICIAL_HANDLE;
  await query(
    `INSERT INTO feed_profiles (user_id, handle, name, bio, official) VALUES ($1, $2, 'Planejai', $3, true)
     ON CONFLICT (user_id) DO UPDATE SET official = true`,
    [id, handle, OFFICIAL_BIO],
  );
  return id;
}

/** Texto do WhatsApp sem a marcação (*negrito*, _itálico_, ~riscado~). */
export const plainCaption = (s: string) =>
  s
    .replace(/(^|\s)[*_~]+(\S[^*_~\n]*?\S|\S)[*_~]+(?=\s|$|[.,!?])/g, "$1$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 500);

async function seed(official: string) {
  const done = await one("SELECT 1 FROM feed_posts WHERE source LIKE 'seed:%' LIMIT 1");
  if (done) return 0;
  let n = 0;
  for (const [i, p] of SEED.entries()) {
    const r = await query(
      `INSERT INTO feed_posts (user_id, body, card, source, created_at) VALUES ($1, $2, $3, $4, now() - make_interval(hours => $5) - make_interval(mins => $6))
       ON CONFLICT (source) WHERE source IS NOT NULL DO NOTHING`,
      [official, p.body, p.card ?? null, `seed:${i + 1}`, p.h, (i * 17) % 50],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}

async function mirrorBlog(official: string) {
  const base = config.PUBLIC_URL.replace(/\/+$/, "");
  const posts = await many<{ id: string; slug: string; title: string; subtitle: string; excerpt: string; published_at: string; data: Buffer }>(
    `SELECT p.id, p.slug, p.title, p.subtitle, p.excerpt, p.published_at, i.data FROM blog_posts p
       JOIN blog_images i ON i.post_id = p.id AND i.slot = 'cover'
      WHERE p.status = 'published' AND p.published_at <= now() AND p.published_at > now() - interval '60 days'
        AND NOT EXISTS (SELECT 1 FROM feed_posts f WHERE f.source = 'blog:' || p.id::text)
      ORDER BY p.published_at DESC LIMIT 10`,
  );
  let n = 0;
  for (const p of posts) {
    const row = await one<{ id: string }>(
      `INSERT INTO feed_posts (user_id, body, link_url, link_title, link_desc, source, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source) WHERE source IS NOT NULL DO NOTHING RETURNING id`,
      [official, (p.excerpt || "").slice(0, 400), `${base}/blog/${p.slug}`, p.title.slice(0, 160), (p.subtitle || "").slice(0, 200), `blog:${p.id}`, p.published_at],
    );
    if (!row) continue;
    try {
      await attachServerPhoto({ post_id: row.id }, p.data);
    } catch {
      /* capa em formato estranho: o cartão sai sem foto */
    }
    n++;
  }
  return n;
}

async function mirrorWhatsAppStatus(official: string) {
  const rows = await many<{ id: string; caption: string; data: Buffer; posted_at: string; fresh: boolean }>(
    `SELECT s.id, s.caption, s.data, s.posted_at, s.posted_at > now() - interval '24 hours' AS fresh FROM wa_status_posts s
      WHERE s.status = 'postado' AND s.kind = 'imagem' AND s.posted_at > now() - interval '60 days'
        AND NOT EXISTS (SELECT 1 FROM feed_posts f WHERE f.source = 'wa_status:' || s.id::text)
      ORDER BY s.posted_at DESC LIMIT 10`,
  );
  let n = 0;
  for (const s of rows) {
    const caption = plainCaption(s.caption);
    const post = await one<{ id: string }>(
      `INSERT INTO feed_posts (user_id, body, source, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (source) WHERE source IS NOT NULL DO NOTHING RETURNING id`,
      [official, caption, `wa_status:${s.id}`, s.posted_at],
    );
    if (!post) continue;
    try {
      await attachServerPhoto({ post_id: post.id }, s.data);
    } catch {
      await query("DELETE FROM feed_posts WHERE id = $1", [post.id]);
      continue;
    }
    n++;
    // ainda dentro das 24 h: entra também na fileira de status da rede, vencendo junto com o do WhatsApp
    if (s.fresh) {
      const st = await one<{ id: string }>(
        `INSERT INTO feed_status (user_id, kind, body, source, created_at, expires_at) VALUES ($1, 'photo', $2, $3, $4, $4::timestamptz + interval '24 hours')
         ON CONFLICT (source) WHERE source IS NOT NULL DO NOTHING RETURNING id`,
        [official, caption.slice(0, 220), `wa_status:${s.id}`, s.posted_at],
      );
      if (st) await attachServerPhoto({ status_id: st.id }, s.data).catch(() => query("DELETE FROM feed_status WHERE id = $1", [st.id]));
    }
  }
  return n;
}

/** Cria o perfil oficial, os posts de partida e espelha blog e status do WhatsApp. Pode rodar quantas vezes quiser. */
export async function syncOfficialFeed() {
  const official = await ensureOfficial();
  const seeded = await seed(official);
  const blog = await mirrorBlog(official);
  const status = await mirrorWhatsAppStatus(official);
  return { seeded, blog, status };
}
