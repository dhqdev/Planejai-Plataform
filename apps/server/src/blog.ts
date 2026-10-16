import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Tracer } from "./agent/trace.js";
import { htmlToPng } from "./charts.js";
import { config } from "./config.js";
import { many, one, query } from "./db/pool.js";
import { chatCompletion } from "./llm/openrouter.js";
import { resolveModel } from "./llm/router.js";
import { notify } from "./notifications.js";
import { SEED_POSTS } from "./blog-seed.js";
import { tzOffsetMs } from "./time.js";

/**
 * Blog público (/blog), no jeito de revista: posts longos com ilustração no topo e outra no meio do texto.
 * Toda semana o worker escreve um post novo sozinho (rota "blog" em Modelos) e gera as ilustrações (rota "blog:image").
 * Além do semanal, sai um post "Novidades do Planejai" quando o sistema ganha mudanças que o cliente vê (novidades.json, feito pelo CI).
 * Nada aqui fala com cliente nem mexe em dado de ninguém: é conteúdo público da plataforma, o custo não sai de grãos.
 */

export const UPDATES_CATEGORY = "Novidades do Planejai";
export const BLOG_CATEGORIES = ["Dicas de produtividade", "Dinheiro e finanças", "Comparações", "Inteligência artificial", UPDATES_CATEGORY] as const;
/** categorias do post semanal (novidades só sai das mudanças do sistema) */
const TOPIC_CATEGORIES = BLOG_CATEGORIES.filter((c) => c !== UPDATES_CATEGORY);
export const BLOG_AUTHOR = "Equipe Planejai";

/**
 * Estilo único das ilustrações (guache com textura, cena cheia de ponta a ponta): todas as capas parecem da mesma revista.
 * Testado com google/gemini-3-pro-image-preview em out/2026 (~US$ 0,14 por imagem). Mudou o estilo? Suba IMAGE_STYLE_VERSION
 * e as ilustrações de todos os posts são refeitas aos poucos pelo worker.
 */
export const IMAGE_STYLE =
  "Richly detailed contemporary editorial illustration for a premium lifestyle blog. Hand-painted gouache look with dry-brush texture, " +
  "fine grain and subtle colored-pencil hatching; flat shapes with soft painterly shading and a slight risograph speckle. " +
  "Bold, saturated but harmonious palette: coral and tomato red, bubblegum pink, lavender and periwinkle, cobalt blue, sunflower yellow, " +
  "sage and leaf green, warm cream paper tones. Dense, layered composition that fills the whole frame edge to edge, objects overlapping " +
  "with depth and some cropped by the borders, playful dynamic angles, small hand-drawn motion dashes and sparkles around key objects. " +
  "Any screens, calendars, cards or chat bubbles show only abstract colored bars and blocks, never readable words. " +
  "No text, letters, numbers, logos or brand names anywhere, no realistic human faces, no watermark. Scene: ";
export const IMAGE_STYLE_VERSION = 2;

export interface BlogSettings {
  /** escreve um post novo toda semana */
  auto: boolean;
  /** dia da semana (0 = domingo) e hora local do post semanal */
  weekday: number;
  hour: number;
  /** post de novidades quando o sistema ganha mudanças que o cliente vê */
  updates: boolean;
  /** os posts de partida já entraram uma vez (apagar todos não traz de volta) */
  seeded?: boolean;
  /** versão do estilo com que as ilustrações foram feitas (menor que IMAGE_STYLE_VERSION = refazer) */
  styleVersion?: number;
  /** último commit já lido para o post de novidades */
  updatesSha?: string;
  /** última tentativa de post de novidades que falhou (espera um dia para tentar de novo) */
  updatesFailedAt?: string;
}

const DEFAULTS: BlogSettings = { auto: true, weekday: 1, hour: 9, updates: true };

export async function blogSettings(): Promise<BlogSettings> {
  const row = await one<{ value: Partial<BlogSettings> }>("SELECT value FROM settings WHERE key = 'blog'");
  return { ...DEFAULTS, ...(row?.value ?? {}) };
}

export async function saveBlogSettings(patch: Partial<BlogSettings>) {
  const cur = await blogSettings();
  const next: BlogSettings = {
    auto: patch.auto === undefined ? cur.auto : Boolean(patch.auto),
    weekday: patch.weekday === undefined ? cur.weekday : Math.min(6, Math.max(0, Math.trunc(Number(patch.weekday)) || 0)),
    hour: patch.hour === undefined ? cur.hour : Math.min(23, Math.max(0, Math.trunc(Number(patch.hour)) || 0)),
    updates: patch.updates === undefined ? cur.updates : Boolean(patch.updates),
    seeded: patch.seeded ?? cur.seeded,
    styleVersion: patch.styleVersion ?? cur.styleVersion,
    updatesSha: patch.updatesSha ?? cur.updatesSha,
    updatesFailedAt: patch.updatesFailedAt === undefined ? cur.updatesFailedAt : patch.updatesFailedAt || undefined,
  };
  await query(
    "INSERT INTO settings (key, value) VALUES ('blog', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()",
    [JSON.stringify(next)],
  );
  return next;
}

export function slugify(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

const plain = (md: string) =>
  md
    .replace(/\[\[imagem\]\]/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

export function readingMinutes(body: string) {
  const words = plain(body).split(" ").filter(Boolean).length;
  return Math.max(3, Math.round(words / 200));
}

/** Resumo do cartão: o primeiro parágrafo de verdade do texto, cortado numa palavra. */
export function excerptOf(body: string, max = 220) {
  const para = body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(#|>|-|\d+\.|\||\[\[)/.test(p)) ?? "";
  const t = plain(para);
  if (t.length <= max) return t;
  return `${t.slice(0, max).replace(/\s+\S*$/, "")}...`;
}

export interface PostDraft {
  title: string;
  subtitle: string;
  category: string;
  body: string;
  cover_prompt: string;
  inline_prompt: string | null;
}

/** Confere o JSON do redator. Devolve o rascunho limpo ou o motivo da recusa (volta para o modelo uma vez). */
export function cleanDraft(raw: any): PostDraft | string {
  if (!raw || typeof raw !== "object") return "a resposta não era um objeto JSON";
  const title = String(raw.title ?? "").replace(/\s+/g, " ").trim();
  if (title.length < 12 || title.length > 130) return "title precisa ter entre 12 e 130 caracteres";
  let body = String(raw.body ?? "").replace(/\r\n/g, "\n");
  body = body
    .split("\n")
    .filter((l) => !/^#\s/.test(l)) // o título já vem no topo da página
    .join("\n")
    .replace(/<\/?[a-z][^>]*>/gi, "") // nada de HTML cru
    .replace(/\s*[—–]\s*/g, ", ") // travessão vira vírgula (estilo do Planejai)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const sections = (body.match(/^## /gm) ?? []).length;
  if (body.length < 2500) return "body curto demais: escreva de 1000 a 1500 palavras";
  if (sections < 3) return "body precisa de pelo menos 3 seções com '## '";
  const inline = String(raw.inline_prompt ?? "").trim() || null;
  // uma ilustração no meio no máximo; sem a marca, entra antes da terceira seção
  const marks = body.split("[[imagem]]");
  if (marks.length > 2) body = marks[0] + "[[imagem]]" + marks.slice(1).join("");
  if (inline && !body.includes("[[imagem]]")) {
    const at = [...body.matchAll(/^## /gm)][2]?.index;
    if (at != null) body = `${body.slice(0, at)}[[imagem]]\n\n${body.slice(at)}`;
  }
  if (!inline) body = body.replace(/\[\[imagem\]\]\n*/g, "");
  const cover = String(raw.cover_prompt ?? "").trim();
  if (cover.length < 20) return "cover_prompt precisa descrever a cena da capa";
  const category = BLOG_CATEGORIES.find((c) => c.toLowerCase() === String(raw.category ?? "").trim().toLowerCase()) ?? BLOG_CATEGORIES[0];
  return {
    title,
    subtitle: String(raw.subtitle ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
    category,
    body,
    cover_prompt: cover.slice(0, 1200),
    inline_prompt: inline?.slice(0, 1200) ?? null,
  };
}

async function uniqueSlug(base: string) {
  const root = slugify(base) || "post";
  for (let i = 1; i < 50; i++) {
    const slug = i === 1 ? root : `${root}-${i}`;
    if (!(await one("SELECT 1 FROM blog_posts WHERE slug = $1", [slug]))) return slug;
  }
  return `${root}-${Date.now()}`;
}

export async function insertPost(d: PostDraft & { slug?: string; publishedAt?: Date }, source: "seed" | "auto" | "manual") {
  const slug = d.slug ?? (await uniqueSlug(d.title));
  return one<{ id: string; slug: string; title: string }>(
    `INSERT INTO blog_posts (slug, title, subtitle, category, excerpt, body, cover_prompt, inline_prompt, reading_minutes, source, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, now()))
     ON CONFLICT (slug) DO NOTHING RETURNING id, slug, title`,
    [slug, d.title, d.subtitle, d.category, excerptOf(d.body), d.body, d.cover_prompt, d.inline_prompt, readingMinutes(d.body), source, d.publishedAt ?? null],
  );
}

/** Posts de partida: entram uma vez só, com o blog vazio. */
export async function seedBlog() {
  const s = await blogSettings();
  if (s.seeded) return 0;
  const has = await one("SELECT 1 FROM blog_posts LIMIT 1");
  let n = 0;
  if (!has) {
    for (const p of SEED_POSTS) {
      const r = await insertPost({ ...p, publishedAt: new Date(Date.now() - p.daysAgo * 86_400_000) }, "seed");
      if (r) n++;
    }
  }
  await saveBlogSettings({ seeded: true });
  return n;
}

// ---------------------------------------------------------------- escrever

const WRITER_SYSTEM =
  "Você escreve o blog do Planejai, um assistente pessoal no WhatsApp com um time de agentes de IA: um líder conversa com a pessoa e chama " +
  "especialistas (agenda, finanças, pesquisa, e-mail, recados). O que ele faz de verdade: anota gastos por texto, áudio ou foto do comprovante e mostra " +
  "para onde vai o dinheiro; controla cartões e faturas; lembra contas e compromissos; organiza a agenda (inclusive Google Agenda); pesquisa preços e " +
  "informações; guarda documentos e notas; lê PDFs; manda recados para contatos e estabelecimentos só depois do \"sim\" da pessoa. Tem um painel no navegador.\n" +
  "Escreva em português do Brasil, tom de revista leve e prático, frases curtas, falando com \"você\". Público: brasileiros comuns que querem organizar a rotina e o dinheiro.\n" +
  "Regras: texto 100% original; não invente números, estatísticas, pesquisas, preços, leis ou datas (prefira conselhos práticos; contas de exemplo podem, com valores redondos e certos); " +
  "não fale mal de marcas; o Planejai aparece em no máximo 2 trechos, de forma natural e útil, nunca como propaganda pesada; sem emojis; sem travessão (use vírgula ou dois-pontos).\n" +
  "Formato do body (markdown simples): 2 parágrafos de abertura; de 4 a 6 seções com '## ' cujos títulos respondem perguntas que as pessoas buscam no Google; " +
  "parágrafos curtos; pelo menos uma lista com '- ' ou '1. ' (item pode começar com **negrito**); uma tabela simples com '|' quando ajudar a comparar; " +
  "uma dica destacada numa linha começando com '> **Dica:** '; a linha [[imagem]] sozinha entre a segunda e a terceira seção; termine com '## Perguntas frequentes' " +
  "com 3 a 5 perguntas em '### ' e a resposta curta embaixo. Sem título '# ' no body, sem links. De 1000 a 1500 palavras.\n" +
  "cover_prompt e inline_prompt em inglês, 50 a 90 palavras cada: descreva só a cena da ilustração, rica e cheia, como capa de revista. Escolha um de dois jeitos: " +
  "(a) natureza-morta vista de cima sobre um fundo de cor viva (rosa, menta, lilás, azul-céu, amarelo), com 8 a 12 objetos do dia a dia ligados ao tema, " +
  "concretos e com detalhe (material, cor), uns sobre os outros e alguns cortados pela borda; ou (b) uma paisagem ou cena lúdica e simbólica " +
  "(colinas, mar, céu, cidade pequena) onde coisas do tema aparecem grandes e fora de escala, como balões de conversa virando nuvens ou um calendário gigante, " +
  "com primeiro plano, meio e fundo. As duas ilustrações do post não repetem o mesmo jeito nem a mesma cor de fundo. " +
  "Sem pessoas com rosto, sem texto, sem números, sem logos e sem marcas.\n" +
  'Responda só JSON: {"title":"...","subtitle":"uma frase","category":"<uma das categorias>","body":"...","cover_prompt":"...","inline_prompt":"..."}';

const UPDATES_SYSTEM =
  "AGORA é um post de novidades do Planejai, feito a partir da lista de mudanças publicadas no sistema (mensagens de commit, escritas para a equipe). " +
  "Conte só o que um cliente comum percebe usando o assistente no WhatsApp ou o painel dele: recursos novos, coisas que ficaram mais fáceis, mais rápidas ou mais claras. " +
  "Deixe de fora: telas e ajustes só do dono da plataforma (Esteira, Blog, Mapa do time, Clientes, Execuções, Gravações, Modelos, Configurações da plataforma, " +
  "integrações do dono como n8n, Mercado Pago, Stripe e Asaas), testes, CI, deploy, versões, refatoração, custos internos, detalhes de segurança, " +
  "nomes de arquivos e de código, e tudo que uma mudança mais nova da lista desligou, tirou ou desfez (Compras e ligações estão desligadas). " +
  "Junte mudanças do mesmo assunto numa seção só, com título que diz o que a pessoa ganha, e um exemplo de como pedir no WhatsApp quando couber. " +
  "Não prometa nada que não esteja na lista. Aqui o Planejai é o assunto, então pode aparecer o post todo, com o mesmo tom leve. " +
  "Pode ter de 600 a 1100 palavras e de 3 a 6 seções; a seção '## Perguntas frequentes' continua no fim. " +
  "As ilustrações mostram de forma lúdica as novidades principais (objetos e cenas, nunca telas com texto). " +
  'Se nenhuma mudança da lista importa para o cliente, responda só {"skip":true,"reason":"..."}.';

/** Categoria da semana: a menos usada nos últimos posts, para o blog variar. */
async function nextCategory() {
  const recent = await many<{ category: string }>("SELECT category FROM blog_posts ORDER BY published_at DESC LIMIT 8");
  const count = (c: string) => recent.filter((r) => r.category === c).length;
  return [...TOPIC_CATEGORIES].sort((a, b) => count(a) - count(b))[0]!;
}

/**
 * Escreve e publica um post novo (redator + ilustrações). Chamado pelo worker toda semana ou pelo botão do painel.
 * Com `updates`, é o post de novidades: o redator escreve só sobre o que o cliente vê nessas mudanças, ou devolve skip.
 * null = o redator achou que não havia novidade para o cliente.
 */
export async function writePost(source: "auto" | "manual", log?: { info: (...a: any[]) => void }, updates?: Novidade[]) {
  if (!config.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY não configurada");
  const category = updates ? UPDATES_CATEGORY : await nextCategory();
  const existing = await many<{ title: string }>("SELECT title FROM blog_posts ORDER BY published_at DESC LIMIT 60");
  const tracer = await Tracer.start({
    trigger: "blog",
    input: updates ? `Post de novidades (${updates.length} mudanças no sistema)` : `Post novo do blog (${category})`,
    noCharge: true,
  });
  try {
    const model = await resolveModel("blog");
    const today = new Intl.DateTimeFormat("pt-BR", { timeZone: config.DEFAULT_TIMEZONE, dateStyle: "long" }).format(new Date());
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: updates ? `${WRITER_SYSTEM}\n${UPDATES_SYSTEM}` : WRITER_SYSTEM },
      {
        role: "user",
        content: updates
          ? `Categoria: ${UPDATES_CATEGORY}.\nHoje é ${today}.\n` +
            `Posts que já existem (não conte de novo o que já foi contado):\n${existing.map((e) => `- ${e.title}`).join("\n") || "- nenhum"}\n` +
            `Mudanças publicadas no sistema desde o último post de novidades (mais nova primeiro):\n` +
            updates.map((u) => `- ${u.date.slice(0, 10)}: ${u.subject}`).join("\n")
          : `Categorias: ${TOPIC_CATEGORIES.join(", ")}.\nCategoria desta semana: ${category}.\nHoje é ${today}.\n` +
            `Posts que já existem (não repita o tema nem o ângulo):\n${existing.map((e) => `- ${e.title}`).join("\n") || "- nenhum"}\n` +
            "Escolha um tema novo, útil e com cara de busca real no Google, e escreva o post.",
      },
    ];
    let draft: PostDraft | null = null;
    for (let attempt = 0; attempt < 2 && !draft; attempt++) {
      const step = await tracer.step({ agent: "blog", type: "llm", name: attempt ? "redator do blog (de novo)" : "redator do blog", input: { category } });
      const r = await chatCompletion(model, {
        messages: messages as any,
        maxTokens: Math.max(model.maxTokens ?? 0, 6000),
        responseFormat: { type: "json_object" },
        reasoning: "off",
      });
      const text = String(r.message.content ?? "");
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text.replace(/^\s*```(json)?|```\s*$/g, ""));
      } catch {
        parsed = null;
      }
      if (updates && (parsed as any)?.skip === true) {
        await step.ok({ skip: String((parsed as any).reason ?? "").slice(0, 300) }, { model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd });
        await tracer.finish("Sem novidade para o cliente nessas mudanças");
        return null;
      }
      const res = cleanDraft(parsed);
      if (typeof res !== "string") res.category = updates ? UPDATES_CATEGORY : res.category === UPDATES_CATEGORY ? category : res.category;
      const usage = { model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd };
      if (typeof res === "string") {
        await step.ok({ recusado: res, trecho: text.slice(0, 400) }, usage);
        messages.push({ role: "assistant", content: text.slice(0, 4000) }, { role: "user", content: `Não serviu: ${res}. Mande o JSON completo de novo, corrigido.` });
      } else {
        await step.ok({ title: res.title, category: res.category, chars: res.body.length }, usage);
        draft = res;
      }
    }
    if (!draft) throw new Error("o redator não entregou um post válido em 2 tentativas");
    const post = await insertPost(draft, source);
    if (!post) throw new Error("não consegui salvar o post");
    for (const slot of ["cover", "inline"] as const) {
      if (slot === "inline" && !draft.inline_prompt) continue;
      await generateImage(post.id, slot, tracer).catch(() => {}); // falhou: o worker tenta de novo de hora em hora
    }
    await tracer.finish(`Publicado: ${post.title}`);
    await notify({ userId: null, kind: "blog", title: "Post novo no blog", body: post.title, link: `/blog/${post.slug}` });
    log?.info({ slug: post.slug }, "blog: post novo publicado");
    return post;
  } catch (err) {
    await tracer.error(err);
    throw err;
  }
}

// ---------------------------------------------------------------- ilustrações

/** Largura do PNG (cabeçalho IHDR), para não esticar a imagem ao converter. */
function pngWidth(buf: Buffer) {
  return buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 ? buf.readUInt32BE(16) : 0;
}

/** PNG pesado do modelo vira JPEG leve pelo navegador da stack; sem navegador fica o original. */
async function compress(img: { data: Buffer; mimetype: string }) {
  if (img.mimetype === "image/jpeg" && img.data.length < 400_000) return img;
  try {
    const width = Math.min(1600, pngWidth(img.data) || 1344);
    const html = `<!doctype html><html><body style="margin:0;background:#fff"><img src="data:${img.mimetype};base64,${img.data.toString("base64")}" style="display:block;width:${width}px;height:auto"></body></html>`;
    const b64 = await htmlToPng(html, width, { type: "jpeg", quality: 84 });
    const out = Buffer.from(b64, "base64");
    return out.length && out.length < img.data.length ? { data: out, mimetype: "image/jpeg" } : img;
  } catch {
    return img;
  }
}

export async function generateImage(postId: string, slot: "cover" | "inline", parent?: Tracer) {
  const post = await one<{ title: string; cover_prompt: string; inline_prompt: string | null }>(
    "SELECT title, cover_prompt, inline_prompt FROM blog_posts WHERE id = $1",
    [postId],
  );
  if (!post) throw new Error("post não encontrado");
  const scene = slot === "cover" ? post.cover_prompt : post.inline_prompt;
  if (!scene) throw new Error("este post não tem ilustração no meio");
  const tracer = parent ?? (await Tracer.start({ trigger: "blog", input: `Ilustração (${slot === "cover" ? "capa" : "meio"}): ${post.title}`, noCharge: true }));
  const step = await tracer.step({ agent: "imagem", type: "llm", name: slot === "cover" ? "capa do blog" : "ilustração do blog", input: { scene } });
  try {
    const r = await chatCompletion(await resolveModel("blog:image"), {
      modalities: ["image", "text"],
      imageConfig: { aspect_ratio: "16:9" },
      messages: [{ role: "user", content: `Generate one wide 16:9 image. ${IMAGE_STYLE}${scene}` }],
    });
    const url = r.message.images?.[0];
    const m = url?.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
    if (!m) throw new Error("O modelo de imagem não devolveu imagem.");
    const img = await compress({ mimetype: m[1]!, data: Buffer.from(m[2]!, "base64") });
    await query(
      `INSERT INTO blog_images (post_id, slot, mimetype, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (post_id, slot) DO UPDATE SET mimetype = $3, data = $4, created_at = now()`,
      [postId, slot, img.mimetype, img.data],
    );
    await query("DELETE FROM blog_image_failures WHERE post_id = $1 AND slot = $2", [postId, slot]);
    await query("UPDATE blog_posts SET updated_at = now() WHERE id = $1", [postId]);
    await step.ok({ mimetype: img.mimetype, bytes: img.data.length }, { model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd });
    if (!parent) await tracer.finish(`Ilustração salva (${Math.round(img.data.length / 1024)} KB)`);
  } catch (err) {
    await step.fail(err);
    await query(
      `INSERT INTO blog_image_failures (post_id, slot, attempts, last_error) VALUES ($1, $2, 1, $3)
       ON CONFLICT (post_id, slot) DO UPDATE SET attempts = blog_image_failures.attempts + 1, last_error = $3, updated_at = now()`,
      [postId, slot, err instanceof Error ? err.message.slice(0, 300) : String(err)],
    ).catch(() => {});
    if (!parent) await tracer.error(err);
    throw err;
  }
}

/** Posts publicados sem ilustração (os de partida e as que falharam): até `limit` por rodada, 3 tentativas cada. */
export async function fillMissingImages(limit = 2) {
  if (!config.OPENROUTER_API_KEY) return 0;
  const todo = await many<{ id: string; slot: "cover" | "inline" }>(
    `SELECT p.id, s.slot FROM blog_posts p
       CROSS JOIN (VALUES ('cover'), ('inline')) AS s(slot)
       LEFT JOIN blog_images i ON i.post_id = p.id AND i.slot = s.slot
       LEFT JOIN blog_image_failures f ON f.post_id = p.id AND f.slot = s.slot
      WHERE p.status = 'published' AND i.post_id IS NULL AND COALESCE(f.attempts, 0) < 3
        AND (s.slot = 'cover' OR (p.inline_prompt IS NOT NULL AND p.body LIKE '%[[imagem]]%'))
      ORDER BY s.slot = 'cover' DESC, p.published_at DESC LIMIT $1`,
    [limit],
  );
  let n = 0;
  for (const t of todo) {
    try {
      await generateImage(t.id, t.slot);
      n++;
    } catch {
      /* contado em blog_image_failures */
    }
  }
  return n;
}

// ---------------------------------------------------------------- novidades do sistema

/** Uma mudança publicada (commit na main). O CI grava a lista em apps/server/novidades.json antes de montar a imagem. */
export interface Novidade {
  sha: string;
  date: string;
  subject: string;
}

const NOVIDADES_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "novidades.json");

/** Mudanças da imagem em execução, a mais nova primeiro. Sem o arquivo (rodando local) = nenhuma. */
export function readNovidades(file = NOVIDADES_FILE): Novidade[] {
  try {
    const list = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(list)) return [];
    return list
      .filter((c) => c && typeof c.sha === "string" && typeof c.subject === "string" && typeof c.date === "string")
      .map((c) => ({ sha: c.sha, date: c.date, subject: c.subject.slice(0, 400) }));
  } catch {
    return [];
  }
}

/**
 * Hora do post de novidades: pelo menos 3 mudanças desde o último commit lido e o último post de novidades tem mais de 3 dias.
 * Na primeira vez entram as mudanças dos últimos 10 dias. Devolve as mudanças (até 60) ou null.
 */
export async function updatesDue(list = readNovidades(), now = new Date()): Promise<Novidade[] | null> {
  const s = await blogSettings();
  if (!s.updates || !list.length) return null;
  if (s.updatesFailedAt && now.getTime() - new Date(s.updatesFailedAt).getTime() < 86_400_000) return null;
  const idx = s.updatesSha ? list.findIndex((c) => c.sha === s.updatesSha) : -1;
  const fresh = idx >= 0 ? list.slice(0, idx) : list.filter((c) => now.getTime() - Date.parse(c.date) < 10 * 86_400_000);
  if (fresh.length < 3) return null;
  const last = await one<{ at: Date | null }>("SELECT max(published_at) AS at FROM blog_posts WHERE category = $1", [UPDATES_CATEGORY]);
  if (last?.at && now.getTime() - new Date(last.at).getTime() < 3 * 86_400_000) return null;
  return fresh.slice(0, 60);
}

/** Escreve o post de novidades (ou não, se nada importa ao cliente) e marca as mudanças como lidas. */
export async function writeUpdatesPost(list: Novidade[], log?: { info: (...a: any[]) => void }) {
  try {
    const post = await writePost("auto", log, list);
    await saveBlogSettings({ updatesSha: list[0]!.sha, updatesFailedAt: "" });
    return post;
  } catch (err) {
    await saveBlogSettings({ updatesFailedAt: new Date().toISOString() });
    throw err;
  }
}

/** Estilo novo das ilustrações: os de partida pegam as cenas novas e todas as ilustrações são refeitas pelo worker. */
export async function restyleImages() {
  const s = await blogSettings();
  if ((s.styleVersion ?? 1) >= IMAGE_STYLE_VERSION) return false;
  for (const p of SEED_POSTS) {
    await query("UPDATE blog_posts SET cover_prompt = $2, inline_prompt = $3 WHERE slug = $1 AND source = 'seed'", [p.slug, p.cover_prompt, p.inline_prompt]);
  }
  await query("DELETE FROM blog_images");
  await query("DELETE FROM blog_image_failures");
  await saveBlogSettings({ styleVersion: IMAGE_STYLE_VERSION });
  return true;
}

// ---------------------------------------------------------------- agenda semanal

/** Hora de postar: é o dia e a hora escolhidos (fuso da stack) e o último post tem mais de 6 dias. */
export async function weeklyDue(now = new Date()) {
  const s = await blogSettings();
  if (!s.auto) return false;
  const local = new Date(now.getTime() + tzOffsetMs(now, config.DEFAULT_TIMEZONE));
  if (local.getUTCDay() !== s.weekday || local.getUTCHours() < s.hour) return false;
  const last = await one<{ at: Date }>("SELECT max(published_at) AS at FROM blog_posts WHERE source <> 'seed' AND category <> $1", [UPDATES_CATEGORY]);
  const lastAny = await one<{ at: Date }>("SELECT max(published_at) AS at FROM blog_posts");
  const ref = last?.at ?? lastAny?.at ?? null;
  return !ref || now.getTime() - new Date(ref).getTime() > 6 * 86_400_000;
}

export type BlogJob = { action?: "tick" | "write" | "image"; postId?: string; slot?: "cover" | "inline" };

/** De hora em hora (e pelo painel): posts de partida, ilustrações que faltam e o post da semana. */
export async function runBlogJob(log: { info: (...a: any[]) => void; error: (...a: any[]) => void }, job: BlogJob = {}) {
  if (job.action === "write") return void (await writePost("manual", log));
  if (job.action === "image" && job.postId) {
    await query("DELETE FROM blog_image_failures WHERE post_id = $1 AND slot = $2", [job.postId, job.slot ?? "cover"]);
    return void (await generateImage(job.postId, job.slot ?? "cover"));
  }
  await seedBlog();
  await restyleImages();
  await fillMissingImages(4);
  if (!config.OPENROUTER_API_KEY) return;
  if (await weeklyDue()) {
    await writePost("auto", log).catch((err) => log.error({ err }, "blog: post da semana falhou (tento na próxima hora)"));
  }
  const updates = await updatesDue();
  if (updates) await writeUpdatesPost(updates, log).catch((err) => log.error({ err }, "blog: post de novidades falhou (tento amanhã)"));
}
