import { config } from "../config.js";
import { getCredentials, rawCredentials, saveCredentials } from "./registry.js";

/**
 * Mercado Livre (OAuth 2.0 do DevCenter). O access token dura 6h e o refresh token é de uso único:
 * cada renovação devolve um refresh token novo, que precisa ser salvo na hora.
 * No app do DevCenter marque o escopo "offline_access" (sem ele não vem refresh token).
 */
const API = "https://api.mercadolibre.com";

export const mercadolivreRedirectUri = () => `${config.PUBLIC_URL.replace(/\/$/, "")}/api/integrations/mercadolivre/oauth/callback`;

export async function mercadolivreAuthUrl(state: string) {
  const c = await rawCredentials("mercadolivre");
  if (!c.client_id) throw new Error("Salve o App ID e a Secret Key do Mercado Livre antes de conectar");
  const p = new URLSearchParams({ response_type: "code", client_id: c.client_id, redirect_uri: mercadolivreRedirectUri(), state });
  return `https://auth.mercadolivre.com.br/authorization?${p}`;
}

let tokenCache: { token: string; exp: number } | null = null;

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Mercado Livre OAuth: ${j.message ?? j.error ?? res.status}`);
  return j;
}

export async function mercadolivreExchangeCode(code: string) {
  const c = await rawCredentials("mercadolivre");
  const j = await tokenRequest({
    grant_type: "authorization_code",
    client_id: c.client_id ?? "",
    client_secret: c.client_secret ?? "",
    code,
    redirect_uri: mercadolivreRedirectUri(),
  });
  if (!j.refresh_token) throw new Error('O Mercado Livre não devolveu refresh_token: ative o escopo "offline_access" no seu app do DevCenter');
  await saveCredentials("mercadolivre", { refresh_token: j.refresh_token, user_id: String(j.user_id ?? "") });
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 };
}

async function accessToken() {
  const c = await getCredentials("mercadolivre");
  if (!c) {
    tokenCache = null;
    throw new Error("Mercado Livre não está conectado");
  }
  if (tokenCache && tokenCache.exp > Date.now()) return tokenCache.token;
  const j = await tokenRequest({ grant_type: "refresh_token", client_id: c.client_id!, client_secret: c.client_secret!, refresh_token: c.refresh_token! });
  // refresh token rotativo: o antigo deixa de valer
  if (j.refresh_token) await saveCredentials("mercadolivre", { refresh_token: j.refresh_token });
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 };
  return tokenCache.token;
}

export class MercadoLivreError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function mercadolivreApi(path: string) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${await accessToken()}`, Accept: "application/json" } });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new MercadoLivreError(`Mercado Livre ${res.status}: ${j.message ?? JSON.stringify(j).slice(0, 200)}`, res.status);
  return j;
}
