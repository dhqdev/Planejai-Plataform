import { chatCompletion } from "../../llm/openrouter.js";
import { resolveModel } from "../../llm/router.js";
import { getCredentials } from "../../integrations/registry.js";
import { one } from "../../db/pool.js";
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
    const max = Math.min(args.max_results ?? 6, 10);
    const tavily = await getCredentials("tavily");
    if (tavily) {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tavily.api_key}` },
        body: JSON.stringify({ query: args.query, max_results: max, include_answer: true, include_images: true }),
      });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Tavily: ${JSON.stringify(j).slice(0, 200)}`);
      return {
        provider: "tavily",
        answer: j.answer,
        results: (j.results ?? []).map((r: any) => ({ title: r.title, url: r.url, content: String(r.content ?? "").slice(0, 800) })),
        images: (j.images ?? []).slice(0, 4),
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
      plugins: [{ id: "web", max_results: max }],
    });
    return { provider: "openrouter-web", model: r.model, answer: r.message.content, _usage: r };
  },
});

export const fetchUrl = defineTool<{ url: string; max_chars?: number }>({
  name: "fetch_url",
  description: "Abre uma página e retorna o texto dela (com links). Usa navegador headless quando disponível, para sites com JavaScript.",
  parameters: obj({ url: { type: "string" }, max_chars: { type: "number" } }, ["url"]),
  async run(args) {
    const max = Math.min(args.max_chars ?? 12_000, 40_000);
    let html: string | null = null;
    try {
      const res = await browserless("/chromium/content", { url: args.url, gotoOptions: { waitUntil: "networkidle2", timeout: 30_000 } });
      if (res) html = await res.text();
    } catch {
      html = null;
    }
    if (html == null) {
      const res = await fetch(args.url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; PlanejaiBot/1.0)", "Accept-Language": "pt-BR,pt;q=0.9" },
        signal: AbortSignal.timeout(20_000),
        redirect: "follow",
      });
      html = await res.text();
    }
    const text = htmlToText(html);
    return { url: args.url, text: text.slice(0, max), truncated: text.length > max };
  },
});

export const screenshotUrl = defineTool<{ url: string; full_page?: boolean; caption?: string }>({
  name: "screenshot_url",
  description:
    "Tira um print de uma página (ex.: grade de sessões do cinema, cardápio, tabela de preços) para mandar como foto. " +
    "Retorna um media_id que o CTO posiciona com [[media:ID]].",
  integration: "browserless",
  parameters: obj({ url: { type: "string" }, full_page: { type: "boolean" }, caption: { type: "string" } }, ["url"]),
  async run(args, ctx) {
    const res = await browserless("/chromium/screenshot", {
      url: args.url,
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

// ---------- Computador (navegador controlado pelo agente, com gravação) ----------

async function saveMediaFile(ctx: ToolContext, kind: string, mimetype: string, data: Buffer, fileName: string) {
  const row = await one<{ id: string }>(
    `INSERT INTO media_files (execution_id, user_id, kind, mimetype, file_name, size, data) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [ctx.tracer.executionId, ctx.user.id, kind, mimetype, fileName, data.length, data],
  );
  return row!.id;
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
    "Abre um navegador de verdade (computador) numa URL para navegar como uma pessoa: clicar, preencher, rolar. " +
    "Use quando a pesquisa precisa interagir com o site (filtros, formulários, login público, vários cliques) ou quando a pessoa pede para ver/gravar. " +
    "record=true grava a tela em vídeo; send_recording=true manda o vídeo para a pessoa no fim. Retorna o texto da página e os elementos clicáveis numerados.",
  parameters: obj({ url: { type: "string" }, record: { type: "boolean" }, send_recording: { type: "boolean" } }, ["url"]),
  async run(args, ctx) {
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
    const { mercadolivreApi } = await import("../../integrations/mercadolivre.js");
    const p = new URLSearchParams({ q: args.query, limit: String(Math.min(args.limit ?? 8, 20)) });
    if (args.sort) p.set("sort", args.sort);
    if (args.condition) p.set("condition", args.condition);
    const j = await mercadolivreApi(`/sites/MLB/search?${p}`);
    return {
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
  },
});
