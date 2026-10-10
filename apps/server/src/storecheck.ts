import { config } from "./config.js";
import { safeFetch } from "./net.js";
import { STORES } from "./stores.js";

/**
 * Teste das lojas a partir do servidor (Compras > Testar lojas, só o dono): a loja deixa um robô de servidor entrar?
 * Duas olhadas na página inicial: HTTP direto (rápido, mostra a proteção anti-robô pelos cabeçalhos) e o Chrome do
 * browserless (o mesmo que a Nina usa). O IP do servidor é de datacenter: é ele que conta, não o da casa da pessoa.
 */

export type CheckState = "ok" | "desafio" | "bloqueado" | "erro";

export interface StoreCheck {
  store: string;
  name: string;
  /** proteção anti-robô que a loja usa, pelos cabeçalhos (Cloudflare, Akamai, DataDome, PerimeterX...) */
  guard: string | null;
  http: { state: CheckState; status: number | null; ms: number };
  browser: { state: CheckState; detail: string; ms: number } | null;
}

const BLOCK = /Hubo un error accediendo|Access Denied|Request blocked|you have been blocked|403 Forbidden|403 ERROR|Attention Required|acesso negado|automated queries/i;
const CHALLENGE = /Just a moment|verify you are (a )?human|captcha|press (and|&) hold|pressione e segure|account-verification|são humanos|não sou um robô|unusual traffic|security check|checking your browser|confirme que você/i;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

/** Quem protege a loja, pelos cabeçalhos e cookies da resposta. */
export function guardOf(headers: Headers): string | null {
  const h = (k: string) => headers.get(k) ?? "";
  const all = `${h("server")} ${h("set-cookie")} ${h("via")} ${[...headers.keys()].join(" ")}`.toLowerCase();
  if (/x-datadome|datadome/.test(all)) return "DataDome";
  if (/_px\w*=|perimeterx|x-px/.test(all)) return "PerimeterX";
  if (/_abck=|bm_sz=|akamai/.test(all)) return "Akamai";
  if (/cf-ray|cloudflare|__cf_bm/.test(all)) return "Cloudflare";
  if (/incap_ses|visid_incap|imperva/.test(all)) return "Imperva";
  if (/cloudfront/.test(all)) return "CloudFront";
  return null;
}

/** O que a página mostrou: bloqueio, desafio (captcha, "segure o botão", verificação de conta) ou a loja. */
export function pageState(text: string, url = ""): CheckState {
  if (BLOCK.test(text) && text.length < 3000) return "bloqueado";
  if (CHALLENGE.test(text) || CHALLENGE.test(url)) return "desafio";
  return text.trim().length < 200 ? "desafio" : "ok";
}

async function viaHttp(home: string) {
  const t0 = Date.now();
  try {
    const res = await safeFetch(home, { headers: { "User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9", Accept: "text/html" }, signal: AbortSignal.timeout(12_000) });
    const html = (await res.text()).slice(0, 200_000);
    const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    // muita loja é só JavaScript: HTTP 200 com pouco texto não é bloqueio
    const state: CheckState = res.status === 403 || res.status === 429 || res.status === 503 ? (CHALLENGE.test(text) ? "desafio" : "bloqueado") : BLOCK.test(text) && text.length < 3000 ? "bloqueado" : CHALLENGE.test(text) ? "desafio" : "ok";
    return { state, status: res.status, ms: Date.now() - t0, guard: guardOf(res.headers) };
  } catch {
    return { state: "erro" as CheckState, status: null, ms: Date.now() - t0, guard: null };
  }
}

async function viaBrowser(home: string): Promise<StoreCheck["browser"]> {
  const { getCredentials } = await import("./integrations/registry.js");
  if (!(await getCredentials("browserless"))?.url && !config.CHROME_PATH) return null;
  const { BrowserSession } = await import("./agent/browser.js");
  const t0 = Date.now();
  let b: Awaited<ReturnType<typeof BrowserSession.open>> | null = null;
  try {
    b = await BrowserSession.open(false);
    await b.goto(home);
    const s = await b.snapshot();
    const state = pageState(s.text, s.url);
    return { state, detail: state === "ok" ? s.title.slice(0, 80) : s.text.replace(/\s+/g, " ").slice(0, 140), ms: Date.now() - t0 };
  } catch (err) {
    return { state: "erro", detail: (err as Error).message.slice(0, 140), ms: Date.now() - t0 };
  } finally {
    await b?.close().catch(() => {});
  }
}

export async function checkStore(id: string): Promise<StoreCheck | null> {
  const def = STORES[id];
  if (!def) return null;
  const http = await viaHttp(def.home);
  return { store: id, name: def.name, guard: http.guard, http: { state: http.state, status: http.status, ms: http.ms }, browser: await viaBrowser(def.home) };
}
