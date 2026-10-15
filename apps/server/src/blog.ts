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
 * Toda semana o worker escreve um post novo sozinho (rota "blog" em Modelos) e gera as ilustrações (rota "Imagens").
 * Nada aqui fala com cliente nem mexe em dado de ninguém: é conteúdo público da plataforma, o custo não sai de grãos.
 */

export const BLOG_CATEGORIES = ["Dicas de produtividade", "Dinheiro e finanças", "Comparações", "Inteligência artificial"] as const;
export const BLOG_AUTHOR = "Equipe Planejai";

/** Estilo único das ilustrações (pintura guache, cores vivas, fundo pastel): todas as capas parecem da mesma revista. */
export const IMAGE_STYLE =
  "Editorial illustration for a lifestyle magazine, hand-painted gouache look with visible brush texture and soft paper grain, " +
  "bold simple shapes, vibrant saturated palette (coral red, bubblegum pink, cobalt blue, sunflower yellow, leaf green, cream) " +
  "over a solid pastel background, warm and playful, clean composition with breathing room, rich detail on the objects. " +
  "Absolutely no text, no letters, no numbers, no logos, no brand names, no watermark, no realistic human faces. Scene: ";

export interface BlogSettings {
  /** escreve um post novo toda semana */
  auto: boolean;
  /** dia da semana (0 = domingo) e hora local do post semanal */
  weekday: number;
  hour: number;
  /** os posts de partida já entraram uma vez (apagar todos não traz de volta) */
  seeded?: boolean;
}

const DEFAULTS: BlogSettings = { auto: true, weekday: 1, hour: 9 };

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
    seeded: patch.seeded ?? cur.seeded,
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
  "cover_prompt e inline_prompt em inglês: descreva só a cena da ilustração (objetos do dia a dia ligados ao tema, arrumados como natureza-morta vista de cima " +
  "ou uma cena aberta e lúdica, com a cor de fundo pastel), sem pessoas com rosto, sem texto, sem logos e sem marcas.\n" +
  'Responda só JSON: {"title":"...","subtitle":"uma frase","category":"<uma das categorias>","body":"...","cover_prompt":"...","inline_prompt":"..."}';

/** Categoria da semana: a menos usada nos últimos posts, para o blog variar. */
async function nextCategory() {
  const recent = await many<{ category: string }>("SELECT category FROM blog_posts ORDER BY published_at DESC LIMIT 8");
  const count = (c: string) => recent.filter((r) => r.category === c).length;
  return [...BLOG_CATEGORIES].sort((a, b) => count(a) - count(b))[0]!;
}

/** Escreve e publica um post novo (redator + ilustrações). Chamado pelo worker toda semana ou pelo botão do painel. */
export async function writePost(source: "auto" | "manual", log?: { info: (...a: any[]) => void }) {
  if (!config.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY não configurada");
  const category = await nextCategory();
  const existing = await many<{ title: string }>("SELECT title FROM blog_posts ORDER BY published_at DESC LIMIT 60");
  const tracer = await Tracer.start({ trigger: "blog", input: `Post novo do blog (${category})`, noCharge: true });
  try {
    const model = await resolveModel("blog");
    const today = new Intl.DateTimeFormat("pt-BR", { timeZone: config.DEFAULT_TIMEZONE, dateStyle: "long" }).format(new Date());
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: WRITER_SYSTEM },
      {
        role: "user",
        content:
          `Categorias: ${BLOG_CATEGORIES.join(", ")}.\nCategoria desta semana: ${category}.\nHoje é ${today}.\n` +
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
      const res = cleanDraft(parsed);
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
    const r = await chatCompletion(await resolveModel("image"), {
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

// ---------------------------------------------------------------- agenda semanal

/** Hora de postar: é o dia e a hora escolhidos (fuso da stack) e o último post tem mais de 6 dias. */
export async function weeklyDue(now = new Date()) {
  const s = await blogSettings();
  if (!s.auto) return false;
  const local = new Date(now.getTime() + tzOffsetMs(now, config.DEFAULT_TIMEZONE));
  if (local.getUTCDay() !== s.weekday || local.getUTCHours() < s.hour) return false;
  const last = await one<{ at: Date }>("SELECT max(published_at) AS at FROM blog_posts WHERE source <> 'seed'");
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
  await fillMissingImages(4);
  if (config.OPENROUTER_API_KEY && (await weeklyDue())) {
    await writePost("auto", log).catch((err) => log.error({ err }, "blog: post da semana falhou (tento na próxima hora)"));
  }
}
