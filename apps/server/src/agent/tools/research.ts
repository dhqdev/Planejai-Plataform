import { chatCompletion } from "../../llm/openrouter.js";
import { resolveModel } from "../../llm/router.js";
import { getCredentials } from "../../integrations/registry.js";
import { defineTool, obj } from "./types.js";

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
      const j: any = await res.json();
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
      const j: any = await res.json();
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
