import { createHash } from "node:crypto";
import { config } from "../config.js";
import { isoLocal } from "../time.js";

/**
 * Ferramentas cujo resultado é público e pode ser reaproveitado entre pessoas por um tempo:
 * a mesma busca ou página lida de novo não gasta API nem token do pesquisador.
 */
const TOOL_CACHE_SECONDS: Record<string, number> = {
  web_search: 6 * 3600,
  fetch_url: 6 * 3600,
  mercadolivre_search: 3600,
  shop_search: 1800,
  places_nearby: 6 * 3600,
};

/** palavras que não mudam o que se procura ("qual a cotação do dólar hoje?" = "dolar") */
const FILLER = new Set(
  "a o as os um uma de do da dos das em no na nos nas pra para pro por com e que qual quais quanto quanta quantos como esta ta tá e é hoje agora atual atualmente agr me diz diga fala sabe saber voce você vc ai aí favor pf pfv ver olha mostra mostre quero queria preciso gostaria tem tinha ".split(
    " ",
  ),
);
const MONEY = /\b(dolar|euro|libra|peso|iene|bitcoin|btc|ethereum|eth|ibovespa|selic|cdi|ouro)\b/;
const WEATHER = /\b(tempo|clima|previsao|chuva|chover|temperatura|frio|calor)\b/;

/**
 * Chave da busca compartilhada entre clientes: sem acento, pontuação e palavras de enchimento, com o dia local.
 * Cotação vale 30 min, previsão do tempo 3 h, o resto 6 h (e nunca passa da meia-noite, porque o dia entra na chave).
 */
export function searchCacheKey(query: string, maxResults?: number): { norm: string; ttl: number } {
  let t = String(query ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const money = MONEY.test(t);
  const weather = !money && WEATHER.test(t);
  // "cotação do dólar", "preço do dólar", "valor do dólar" e "dólar" são a mesma pergunta
  if (money) t = t.replace(/\b(cotacao|preco|valor|quanto custa|quanto esta|quanto ta|comercial|em reais|real|brl)\b/g, " ");
  // "previsão do tempo em Curitiba", "clima Curitiba", "vai chover em Curitiba": tempo + cidade
  if (weather) t = `tempo ${t.replace(new RegExp(WEATHER.source, "g"), " ").replace(/\bvai\b/g, " ")}`;
  const words = t.split(" ").filter((w) => w && !FILLER.has(w));
  const day = isoLocal(new Date(), config.DEFAULT_TIMEZONE).slice(0, 10);
  const norm = `${day}|${Math.min(maxResults ?? 3, 6)}|${words.join(" ")}`;
  return { norm, ttl: money ? 1800 : weather ? 3 * 3600 : 6 * 3600 };
}

export function toolCacheKey(name: string, args: unknown): { key: string; ttl: number } | null {
  const ttl = TOOL_CACHE_SECONDS[name];
  if (!ttl) return null;
  if (name === "web_search" && typeof (args as any)?.query === "string") {
    const s = searchCacheKey((args as any).query, (args as any).max_results);
    return { key: `tool:${name}:${createHash("sha1").update(s.norm).digest("hex")}`, ttl: s.ttl };
  }
  const norm = JSON.stringify(args, Object.keys((args as object) ?? {}).sort()).toLowerCase();
  return { key: `tool:${name}:${createHash("sha1").update(norm).digest("hex")}`, ttl };
}
