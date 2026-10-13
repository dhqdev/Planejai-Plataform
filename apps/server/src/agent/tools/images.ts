import { createHash } from "node:crypto";
import { renderImage, type ImageKind } from "../../images.js";
import { getCredentials } from "../../integrations/registry.js";
import { chatCompletion } from "../../llm/openrouter.js";
import { resolveModel } from "../../llm/router.js";
import { safeFetch } from "../../net.js";
import { defineTool, obj, type ToolContext } from "./types.js";

export const makeImage = defineTool<{
  kind: ImageKind;
  title: string;
  subtitle?: string;
  sections?: { title: string; items?: string[]; text?: string }[];
  columns?: string[];
  rows?: string[][];
  text?: string;
}>({
  name: "make_image",
  description:
    "Imagem com o conteúdo que VOCÊ escreve (sem custo): mapa_mental (title = tema, sections = ramos com items), lista (cartões), " +
    "passos, tabela (columns + rows) ou frase (text). Textos curtos, 2 a 5 itens por ramo. Devolve media_id para [[media:ID]].",
  parameters: obj(
    {
      kind: { type: "string", enum: ["mapa_mental", "lista", "passos", "tabela", "frase"] },
      title: { type: "string" },
      subtitle: { type: "string" },
      sections: {
        type: "array",
        description: "Até 10",
        items: obj(
          {
            title: { type: "string" },
            items: { type: "array", items: { type: "string" } },
            text: { type: "string" },
          },
          ["title"],
        ),
      },
      columns: { type: "array", items: { type: "string" }, description: "Só tabela" },
      rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "Só tabela" },
      text: { type: "string", description: "Só frase" },
    },
    ["kind", "title"],
  ),
  async run(args, ctx) {
    if (args.kind !== "tabela" && args.kind !== "frase" && !args.sections?.length) return { ok: false, error: "Mande sections com o conteúdo." };
    if (args.kind === "tabela" && !(args.columns?.length && args.rows?.length)) return { ok: false, error: "Tabela precisa de columns e rows." };
    const base64 = await renderImage(args);
    const id = ctx.outbox.addMedia({ base64, mimetype: "image/png", caption: undefined, fileName: "imagem.png" });
    return { media_id: id, how_to_send: `Coloque [[media:${id}]] na resposta, com uma frase curta.` };
  },
});

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** URLs de fotos de verdade na busca de imagens (Tavily ou Brave), sem navegador e sem LLM. */
export async function searchPictureUrls(q: string): Promise<string[]> {
  const tavily = await getCredentials("tavily");
  if (tavily) {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tavily.api_key}` },
      body: JSON.stringify({ query: q, max_results: 3, include_images: true }),
      signal: AbortSignal.timeout(20_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (res.ok) return (j.images ?? []).map((i: any) => String(typeof i === "string" ? i : i?.url ?? "")).filter(Boolean);
  }
  const brave = await getCredentials("brave");
  if (brave) {
    const res = await fetch(`https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(q)}&count=6&country=BR&search_lang=pt-br&safesearch=strict`, {
      headers: { "X-Subscription-Token": brave.api_key!, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (res.ok) return (j.results ?? []).map((r: any) => String(r.properties?.url ?? r.thumbnail?.src ?? "")).filter(Boolean);
  }
  return [];
}

/** Baixa a primeira foto que abrir (só internet pública, até 5 MB, sem ícone minúsculo). */
async function downloadFirst(urls: string[]) {
  for (const url of urls.slice(0, 5)) {
    try {
      const res = await safeFetch(url, { signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "Mozilla/5.0 (compatible; PlanejaiBot/1.0)" } });
      const mimetype = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!res.ok || !PHOTO_TYPES.has(mimetype)) continue;
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length < 8_000 || data.length > 5 * 1024 * 1024) continue;
      return { base64: data.toString("base64"), mimetype, url };
    } catch {
      // próxima
    }
  }
  return null;
}

/** Imagem nova pelo modelo barato da rota "image" (OpenRouter devolve data URL em message.images). */
export async function generatePicture(ctx: ToolContext, description: string) {
  const step = await ctx.tracer.step({ agent: "imagem", type: "llm", name: "gerar imagem", parentId: ctx.parentStepId, input: { description } });
  try {
    const r = await chatCompletion(await resolveModel("image"), {
      modalities: ["image", "text"],
      messages: [{ role: "user", content: `Gere uma imagem: ${description.slice(0, 1500)}\nSem texto escrito na imagem, a não ser que o pedido peça.` }],
    });
    const url = r.message.images?.[0];
    const m = url?.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
    let img: { base64: string; mimetype: string } | null = m ? { mimetype: m[1]!, base64: m[2]! } : null;
    if (!img && url?.startsWith("https://")) img = await downloadFirst([url]);
    if (!img) throw new Error("O modelo de imagem não devolveu imagem.");
    await step.ok({ mimetype: img.mimetype, bytes: Math.round((img.base64.length * 3) / 4) }, { model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd });
    return img;
  } catch (err) {
    await step.fail(err);
    throw err;
  }
}

export const getPicture = defineTool<{ description: string; mode?: "buscar" | "gerar"; caption?: string }>({
  name: "make_picture",
  description:
    "Foto, desenho ou ilustração em segundos e por centavos, sem abrir navegador. mode=buscar: foto real de algo que existe (produto, lugar, animal, " +
    "prato, logo); mode=gerar: imagem nova (desenho, arte, ilustração, figurinha, 'cria uma imagem de...'). description com o que deve aparecer " +
    "(e estilo/cores ao gerar). Devolve media_id para [[media:ID]].",
  parameters: obj(
    {
      description: { type: "string" },
      mode: { type: "string", enum: ["buscar", "gerar"] },
      caption: { type: "string", description: "Legenda curta, opcional" },
    },
    ["description"],
  ),
  async run(args, ctx) {
    const description = String(args.description ?? "").trim();
    if (!description) return { ok: false, error: "Diga o que a imagem deve mostrar." };
    let img: { base64: string; mimetype: string } | null = null;
    let generated = args.mode === "gerar";
    if (!generated) {
      img = await downloadFirst(await searchPictureUrls(description).catch(() => []));
      generated = !img;
    }
    if (!img) img = await generatePicture(ctx, description);
    const ext = img.mimetype === "image/png" ? "png" : img.mimetype === "image/webp" ? "webp" : "jpg";
    const id = ctx.outbox.addMedia({ base64: img.base64, mimetype: img.mimetype, caption: args.caption, fileName: `imagem.${ext}` });
    return {
      media_id: id,
      ...(generated && args.mode !== "gerar" ? { note: "Não achei foto real: esta foi gerada. Diga isso à pessoa numa frase." } : {}),
      how_to_send: `Coloque [[media:${id}]] na resposta, com uma frase curta.`,
    };
  },
});

/** Até 5 MB: GIF de reação é curto; maior que isso demora para chegar no celular. */
const MAX_GIF_BYTES = 5 * 1024 * 1024;

/** mp4 dos primeiros GIFs da busca: Klipy primeiro (chave da stack ou da tela), Giphy se não houver Klipy. */
export async function searchGifMp4(q: string, userId: string): Promise<string[]> {
  const klipy = await getCredentials("klipy");
  if (klipy?.api_key) {
    // a Klipy pede um id por pessoa (anônimo): hash do id do usuário, nunca telefone
    const customer = createHash("sha256").update(`planejai:${userId}`).digest("hex").slice(0, 24);
    const res = await fetch(
      `https://api.klipy.com/api/v1/${encodeURIComponent(klipy.api_key)}/gifs/search?q=${encodeURIComponent(q)}&per_page=8&customer_id=${customer}&locale=pt_BR&rating=g`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const j: any = await res.json().catch(() => ({}));
    if (res.ok) {
      const urls = (j.data?.data ?? [])
        .map((g: any) => g?.file?.sm?.mp4?.url ?? g?.file?.md?.mp4?.url ?? g?.file?.hd?.mp4?.url ?? g?.file?.xs?.mp4?.url)
        .filter((u: unknown): u is string => typeof u === "string" && u.startsWith("https://"));
      if (urls.length) return urls;
    }
  }
  const giphy = await getCredentials("giphy");
  if (giphy?.api_key) {
    const res = await fetch(
      `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(giphy.api_key)}&q=${encodeURIComponent(q)}&limit=6&rating=g&lang=pt`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const j: any = await res.json().catch(() => ({}));
    if (res.ok)
      return (j.data ?? [])
        .map((g: any) => g?.images?.downsized_small?.mp4 ?? g?.images?.fixed_height?.mp4 ?? g?.images?.original?.mp4)
        .filter((u: unknown): u is string => typeof u === "string" && u.startsWith("https://"));
  }
  return [];
}

/** Baixa um dos primeiros GIFs (mp4) da busca, sorteado para não repetir sempre o mesmo; null se nada servir. */
export async function fetchGif(q: string, userId: string): Promise<string | null> {
  const query = q.trim().slice(0, 50);
  if (!query) return null;
  const urls = await searchGifMp4(query, userId).catch(() => []);
  for (const url of urls.slice(0, 4).sort(() => Math.random() - 0.5)) {
    try {
      const r = await safeFetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok || !(r.headers.get("content-type") ?? "").includes("mp4")) continue;
      const data = Buffer.from(await r.arrayBuffer());
      if (data.length <= MAX_GIF_BYTES) return data.toString("base64");
    } catch {
      // próximo
    }
  }
  return null;
}
