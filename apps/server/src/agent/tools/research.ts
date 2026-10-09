import { chatCompletion } from "../../llm/openrouter.js";
import { resolveModel } from "../../llm/router.js";
import { getCredentials } from "../../integrations/registry.js";
import { randomUUID } from "node:crypto";
import { query } from "../../db/pool.js";
import { deleteObject, mediaKey, putObject, storageEnabled } from "../../storage.js";
import { checkedUrl, safeFetch } from "../../net.js";
import { BrowserSession, type Snapshot } from "../browser.js";
import { defineTool, obj, type ToolContext } from "./types.js";

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

async function browserless(path: string, body: unknown): Promise<Response | null> {
  const b = await getCredentials("browserless");
  if (!b?.url) return null;
  const url = `${b.url.replace(/\/$/, "")}${path}${b.token ? `?token=${encodeURIComponent(b.token)}` : ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Browserless ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

export const webSearch = defineTool<{ query: string; max_results?: number }>({
  name: "web_search",
  description: "Pesquisa na web informações atuais (sessões de cinema, preços, notícias, horários, endereços, lojas).",
  parameters: obj(
    {
      query: { type: "string", description: "Consulta em linguagem natural, com cidade/data quando fizer sentido" },
      max_results: { type: "number" },
    },
    ["query"],
  ),
  async run(args) {
    // poucos resultados e trechos curtos: tudo que volta daqui vira token na próxima chamada do agente
    const max = Math.min(args.max_results ?? 3, 6);
    const tavily = await getCredentials("tavily");
    if (tavily) {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tavily.api_key}` },
        // a resposta pronta da Tavily (answer) costuma bastar; sem imagens (nenhuma ferramenta usa as URLs delas)
        body: JSON.stringify({ query: args.query, max_results: max, include_answer: true }),
        signal: AbortSignal.timeout(20_000),
      });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Tavily: ${JSON.stringify(j).slice(0, 200)}`);
      return {
        provider: "tavily",
        answer: j.answer,
        results: (j.results ?? []).map((r: any) => ({ title: r.title, url: r.url, content: String(r.content ?? "").slice(0, 500) })),
      };
    }
    const brave = await getCredentials("brave");
    if (brave) {
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(args.query)}&count=${max}&country=BR&search_lang=pt-br`, {
        headers: { "X-Subscription-Token": brave.api_key!, Accept: "application/json" },
      });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Brave: ${JSON.stringify(j).slice(0, 200)}`);
      return {
        provider: "brave",
        results: (j.web?.results ?? []).map((r: any) => ({ title: r.title, url: r.url, content: r.description })),
      };
    }
    // Sem chave de busca: plugin web do OpenRouter num modelo barato
    const r = await chatCompletion(await resolveModel("web_search"), {
      messages: [
        { role: "system", content: "Pesquise e responda com fatos atuais e as URLs das fontes. Seja objetivo." },
        { role: "user", content: args.query },
      ],
      // o plugin cobra por resultado (US$ 4 a cada mil): 3 fontes bastam para quase tudo
      plugins: [{ id: "web", max_results: Math.min(args.max_results ?? 3, 5) }],
    });
    return { provider: "openrouter-web", model: r.model, answer: r.message.content, _usage: r };
  },
});

export const fetchUrl = defineTool<{ url: string; max_chars?: number }>({
  name: "fetch_url",
  description: "Abre uma página e retorna o texto dela (com links). Usa navegador headless quando disponível, para sites com JavaScript.",
  parameters: obj({ url: { type: "string" }, max_chars: { type: "number" } }, ["url"]),
  async run(args) {
    const max = Math.min(args.max_chars ?? 8_000, 30_000);
    const url = await checkedUrl(args.url);
    let html: string | null = null;
    try {
      const res = await browserless("/chromium/content", { url, gotoOptions: { waitUntil: "networkidle2", timeout: 30_000 } });
      if (res) html = await res.text();
    } catch {
      html = null;
    }
    if (html == null) {
      const res = await safeFetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; PlanejaiBot/1.0)", "Accept-Language": "pt-BR,pt;q=0.9" },
        signal: AbortSignal.timeout(20_000),
      });
      html = await res.text();
    }
    const text = htmlToText(html);
    return { url, text: text.slice(0, max), truncated: text.length > max };
  },
});

export const screenshotUrl = defineTool<{ url: string; full_page?: boolean; caption?: string }>({
  name: "screenshot_url",
  description:
    "Tira um print de uma página para mandar como foto. Só use quando o CTO pedir uma imagem (é mais lento que responder em texto). " +
    "Retorna um media_id que o CTO posiciona com [[media:ID]].",
  integration: "browserless",
  parameters: obj({ url: { type: "string" }, full_page: { type: "boolean" }, caption: { type: "string" } }, ["url"]),
  async run(args, ctx) {
    const res = await browserless("/chromium/screenshot", {
      url: await checkedUrl(args.url),
      options: { type: "jpeg", quality: 75, fullPage: Boolean(args.full_page) },
      viewport: { width: 1280, height: 900 },
      gotoOptions: { waitUntil: "networkidle2", timeout: 30_000 },
    });
    if (!res) throw new Error("Navegador (Browserless) não configurado");
    const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
    const id = ctx.outbox.addMedia({ base64, mimetype: "image/jpeg", caption: args.caption, fileName: "print.jpg" });
    return { media_id: id, how_to_send: `Coloque [[media:${id}]] na resposta final onde a imagem deve aparecer.` };
  },
});

// ---------- Mapas (rota com print do Google Maps) ----------

/** Prints de mapa por resposta: cada um abre um navegador (~25 s); a partir daí vai só o link. */
export const MAX_MAP_PRINTS = 2;

const TRAVEL = { onibus: "transit", transporte: "transit", carro: "driving", pe: "walking", bike: "bicycling" } as const;

/** Link do Google Maps: rota (com origem) ou o lugar (só destino). */
export function mapsUrl(destination: string, origin?: string, mode: keyof typeof TRAVEL = "onibus") {
  if (!origin) return `https://www.google.com/maps/search/?${new URLSearchParams({ api: "1", query: destination, hl: "pt-BR" })}`;
  return `https://www.google.com/maps/dir/?${new URLSearchParams({ api: "1", origin, destination, travelmode: TRAVEL[mode] ?? "transit", hl: "pt-BR" })}`;
}

export const mapRoute = defineTool<{ destination: string; origin?: string; mode?: keyof typeof TRAVEL }>({
  name: "map_route",
  description:
    "Mostra no Google Maps como chegar (linha de ônibus/metrô, carro, a pé, bike) ou onde fica um lugar, e devolve um PRINT do mapa (media_id), o link e as opções resumidas. " +
    "Use para 'qual ônibus pego para X', 'como chego em Y', 'onde fica Z'. Responda com 1 ou 2 linhas curtas (linha, horário, tempo) + [[media:ID]] + o link; nada de textão. " +
    "origin: de onde a pessoa sai (endereço, bairro ou cidade; use a localização que ela mandou ou o que você sabe dela; se não souber, mostre só o destino).",
  parameters: obj(
    {
      destination: { type: "string", description: "Para onde (endereço, lugar, bairro + cidade)" },
      origin: { type: "string", description: "De onde (opcional)" },
      mode: { type: "string", enum: Object.keys(TRAVEL), description: "Padrão onibus (transporte público)" },
    },
    ["destination"],
  ),
  async run(args, ctx) {
    const url = mapsUrl(args.destination, args.origin, args.mode ?? "onibus");
    if (ctx.room && ctx.room.usage.mapPrints >= MAX_MAP_PRINTS) {
      return { link: url, note: `Já saíram ${MAX_MAP_PRINTS} mapas nesta resposta: mande só este link, sem print.` };
    }
    if (ctx.room) ctx.room.usage.mapPrints++;
    let b: BrowserSession | null = null;
    try {
      b = await BrowserSession.open(false);
      await b.page.setViewport({ width: 1100, height: 760 });
      await b.goto(url);
      // aviso de cookies do Google (aparece em alguns servidores)
      if (/consent\./.test(b.page.url())) {
        await b.page
          .evaluate(() => {
            const btn = [...document.querySelectorAll("button")].find((x) => /aceitar tudo|accept all|rejeitar tudo|reject all/i.test(x.textContent ?? ""));
            btn?.click();
          })
          .catch(() => {});
        await b.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      }
      const tripSel = 'div[id^="section-directions-trip-"]';
      if (args.origin) await b.page.waitForSelector(tripSel, { timeout: 20_000 }).catch(() => {});
      else await b.page.waitForSelector('h1, [role="main"]', { timeout: 15_000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500)); // mapa termina de desenhar
      const options: string[] = await b.page
        .$$eval(tripSel, (els) => els.slice(0, 3).map((e) => (e as HTMLElement).innerText.replace(/\s*\n\s*/g, " · ").slice(0, 220)))
        .catch(() => []);
      const base64 = await b.screenshot();
      const id = ctx.outbox.addMedia({ base64, mimetype: "image/jpeg", caption: args.origin ? `${args.origin} → ${args.destination}` : args.destination, fileName: "mapa.jpg" });
      return { media_id: id, link: url, options, how_to_send: `Mande [[media:${id}]] com 1 ou 2 linhas curtas e o link.` };
    } catch (e) {
      // sem navegador: pelo menos o link do Maps
      return { link: url, error: `Não deu para tirar o print (${(e as Error).message}). Mande só o link.` };
    } finally {
      await b?.close().catch(() => {});
    }
  },
});

// ---------- Computador (navegador controlado pelo agente, com gravação) ----------

/** Travas do navegador por resposta: abrir e clicar é lento e pesa na máquina. */
export const MAX_BROWSER_OPENS = 2;
export const MAX_BROWSER_ACTIONS = 10;

/** Google Maps no navegador é lento e pesado: para lugar perto e rota há ferramentas próprias. */
export function isMapsUrl(raw: string) {
  try {
    const u = new URL(raw);
    if (u.hostname === "maps.app.goo.gl" || /^maps\.google\./.test(u.hostname)) return true;
    return /(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname.startsWith("/maps");
  } catch {
    return false;
  }
}

async function saveMediaFile(ctx: ToolContext, kind: string, mimetype: string, data: Buffer, fileName: string) {
  // com storage ligado o arquivo vai pro bucket e a linha guarda só a chave
  const id = randomUUID();
  const key = storageEnabled() ? mediaKey(id) : null;
  if (key) await putObject(key, data, mimetype);
  try {
    await query(
      `INSERT INTO media_files (id, execution_id, user_id, kind, mimetype, file_name, size, data, storage_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, ctx.tracer.executionId, ctx.user.id, kind, mimetype, fileName, data.length, key ? null : data, key],
    );
  } catch (err) {
    if (key) await deleteObject(key).catch(() => {});
    throw err;
  }
  return id;
}

function snapshotText(s: Snapshot) {
  return { url: s.url, title: s.title, page_text: s.text, clickable: s.elements || "(nenhum elemento clicável visível)" };
}

/** Fecha o navegador da execução; se a gravação foi pedida, prepara o vídeo para enviar. */
export async function finishBrowser(ctx: ToolContext, opts: { send?: boolean; caption?: string } = {}) {
  const b = ctx.room.browser;
  if (!b) return { ok: false, error: "Nenhum navegador aberto" };
  ctx.room.browser = undefined;
  const video = await b.stopRecording().catch(() => null);
  await b.close();
  if (!video) return { ok: true, recording: null, actions: b.actions };
  const fileId = await saveMediaFile(ctx, "recording", "video/mp4", video, "gravacao.mp4");
  const send = opts.send ?? b.sendRecording;
  const media_id = send
    ? ctx.outbox.addMedia({ kind: "video", base64: video.toString("base64"), mimetype: "video/mp4", caption: opts.caption, fileName: "gravacao.mp4" })
    : null;
  return {
    ok: true,
    recording: { file: `/api/media/${fileId}`, seconds_aprox: Math.round(b.frameCount / 8), size_kb: Math.round(video.length / 1024) },
    media_id,
    actions: b.actions,
    ...(media_id ? { how_to_send: `Coloque [[media:${media_id}]] na resposta final para mandar o vídeo.` } : {}),
  };
}

export const browserOpen = defineTool<{ url: string; record?: boolean; send_recording?: boolean }>({
  name: "browser_open",
  description:
    "Abre um navegador de verdade (computador) numa URL para navegar como uma pessoa: clicar, preencher, rolar. É LENTO (segundos por clique) e pesa na máquina: último recurso. " +
    "Só use quando web_search/fetch_url/places_nearby não resolvem e o site exige interação (filtros, formulário, vários cliques), ou quando a pessoa pede para ver/gravar. Nunca para Google Maps. " +
    "record=true grava a tela em vídeo; send_recording=true manda o vídeo para a pessoa no fim. Retorna o texto da página e os elementos clicáveis numerados.",
  parameters: obj({ url: { type: "string" }, record: { type: "boolean" }, send_recording: { type: "boolean" } }, ["url"]),
  async run(args, ctx) {
    if (isMapsUrl(args.url) && !args.record && !args.send_recording) {
      return { error: "Não abra o Google Maps no navegador: use places_nearby para achar lugares perto (com telefone e distância) e map_route para rota." };
    }
    if (ctx.room.usage.browserOpens >= MAX_BROWSER_OPENS) {
      return { error: `O navegador já foi aberto ${MAX_BROWSER_OPENS} vezes nesta tarefa. Responda com o que já tem.` };
    }
    ctx.room.usage.browserOpens++;
    if (ctx.room.browser) await finishBrowser(ctx, { send: false });
    const b = await BrowserSession.open(Boolean(args.record || args.send_recording));
    b.sendRecording = Boolean(args.send_recording);
    ctx.room.browser = b;
    await b.goto(args.url);
    return snapshotText(await b.snapshot());
  },
});

export const browserAction = defineTool<{ action: string; ref?: number; text?: string; url?: string; key?: string; direction?: string }>({
  name: "browser_action",
  description:
    "Age no navegador aberto: click (ref), type (ref + text), press (key, ex. Enter), scroll (direction up/down), back, goto (url), wait. " +
    "Retorna a página atualizada com novos números de elementos.",
  parameters: obj(
    {
      action: { type: "string", enum: ["click", "type", "press", "scroll", "back", "goto", "wait"] },
      ref: { type: "number", description: "número do elemento na última lista" },
      text: { type: "string" },
      url: { type: "string" },
      key: { type: "string" },
      direction: { type: "string", enum: ["up", "down"] },
    },
    ["action"],
  ),
  async run(args, ctx) {
    const b = ctx.room.browser;
    if (!b) return { error: "Abra o navegador primeiro com browser_open" };
    if (ctx.room.usage.browserActions >= MAX_BROWSER_ACTIONS && !b.sendRecording) {
      return { error: `Já foram ${MAX_BROWSER_ACTIONS} ações no navegador nesta tarefa. Feche (browser_close) e responda com o que já tem.` };
    }
    ctx.room.usage.browserActions++;
    await b.act(args);
    return snapshotText(await b.snapshot());
  },
});

export const browserScreenshot = defineTool<{ caption?: string }>({
  name: "browser_screenshot",
  description: "Tira um print da tela atual do navegador aberto para mandar como foto. Retorna media_id.",
  parameters: obj({ caption: { type: "string" } }),
  async run(args, ctx) {
    const b = ctx.room.browser;
    if (!b) return { error: "Abra o navegador primeiro com browser_open" };
    const base64 = await b.screenshot();
    const id = ctx.outbox.addMedia({ base64, mimetype: "image/jpeg", caption: args.caption, fileName: "tela.jpg" });
    return { media_id: id, how_to_send: `Coloque [[media:${id}]] na resposta final onde a imagem deve aparecer.` };
  },
});

export const browserClose = defineTool<{ send_recording?: boolean; caption?: string }>({
  name: "browser_close",
  description: "Fecha o navegador. Se estava gravando, gera o vídeo (MP4); send_recording=true prepara para mandar à pessoa (retorna media_id).",
  parameters: obj({ send_recording: { type: "boolean" }, caption: { type: "string" } }),
  async run(args, ctx) {
    return finishBrowser(ctx, { send: args.send_recording, caption: args.caption });
  },
});

// ---------- Compras: Mercado Livre ----------

export const mercadolivreSearch = defineTool<{ query: string; limit?: number; sort?: string; condition?: string }>({
  name: "mercadolivre_search",
  description:
    "Busca produtos no Mercado Livre Brasil: preço, frete grátis, condição, vendedor e link. Use para comparar preços e achar onde comprar.",
  integration: "mercadolivre",
  parameters: obj({
    query: { type: "string" },
    limit: { type: "number", description: "padrão 8, máx. 20" },
    sort: { type: "string", enum: ["relevance", "price_asc", "price_desc"] },
    condition: { type: "string", enum: ["new", "used"] },
  }, ["query"]),
  async run(args) {
    const { mercadolivreApi, MercadoLivreError } = await import("../../integrations/mercadolivre.js");
    const limit = Math.min(args.limit ?? 8, 20);
    const p = new URLSearchParams({ q: args.query, limit: String(limit) });
    if (args.sort) p.set("sort", args.sort);
    if (args.condition) p.set("condition", args.condition);
    try {
      // Busca de anúncios (com o token OAuth da conta conectada)
      const j = await mercadolivreApi(`/sites/MLB/search?${p}`);
      return {
        source: "anuncios",
        total: j.paging?.total,
        items: (j.results ?? []).map((r: any) => ({
          title: r.title,
          price: r.price,
          original_price: r.original_price ?? undefined,
          condition: r.condition,
          free_shipping: r.shipping?.free_shipping ?? false,
          installments: r.installments ? `${r.installments.quantity}x de ${r.installments.amount}${r.installments.rate === 0 ? " sem juros" : ""}` : undefined,
          seller: r.seller?.nickname,
          official_store: r.official_store_name ?? undefined,
          link: r.permalink,
          thumbnail: r.thumbnail,
        })),
      };
    } catch (e) {
      // Desde 2025 o Mercado Livre bloqueia /sites/{site}/search (403) para apps não homologados,
      // mesmo com token. Cai para o catálogo: /products/search + ofertas de cada produto.
      if (!(e instanceof MercadoLivreError) || (e.status !== 403 && e.status !== 401)) throw e;
    }
    const n = Math.min(limit, 6); // cada produto custa 1 chamada de ofertas
    let cat: any;
    try {
      cat = await mercadolivreApi(`/products/search?${new URLSearchParams({ status: "active", site_id: "MLB", q: args.query, limit: String(n) })}`);
    } catch (e) {
      if (e instanceof MercadoLivreError && (e.status === 403 || e.status === 401)) {
        return {
          error:
            "O Mercado Livre recusou a busca para este app (403). A busca de anúncios exige app homologado; reconecte a conta no dashboard ou use web_search/browser_open no site.",
        };
      }
      throw e;
    }
    const items = await Promise.all(
      (cat.results ?? []).slice(0, n).map(async (prod: any) => {
        const offers = await mercadolivreApi(`/products/${prod.id}/items?limit=5`).catch(() => null);
        let list: any[] = offers?.results ?? [];
        if (args.condition) list = list.filter((o) => o.condition === args.condition);
        const best = list.sort((a, b) => Number(a.price) - Number(b.price))[0];
        return {
          title: prod.name,
          price: best?.price,
          original_price: best?.original_price ?? undefined,
          condition: best?.condition,
          free_shipping: best?.shipping?.free_shipping ?? false,
          offers: list.length || undefined,
          link: `https://www.mercadolivre.com.br/p/${prod.id}`,
          thumbnail: prod.pictures?.[0]?.url,
        };
      }),
    );
    if (args.sort === "price_asc") items.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    if (args.sort === "price_desc") items.sort((a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity));
    return { source: "catalogo", total: cat.paging?.total, items };
  },
});
