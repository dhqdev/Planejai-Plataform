import { config } from "../config.js";
import { getCredentials, rawCredentials, saveCredentials, savePersonalCredentials } from "./registry.js";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
];

export const googleRedirectUri = () => `${config.PUBLIC_URL.replace(/\/$/, "")}/api/integrations/google/oauth/callback`;

export async function googleAuthUrl(state: string) {
  const creds = await rawCredentials("google");
  if (!creds.client_id) throw new Error("Salve o Client ID e o Client Secret do Google antes de conectar");
  const params = new URLSearchParams({
    client_id: creds.client_id,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** Troca o código do OAuth pelo refresh_token. Com userId, é a conta pessoal de um cliente (Minha conta). */
export async function googleExchangeCode(code: string, userId?: string) {
  const creds = await rawCredentials("google");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: creds.client_id ?? "",
      client_secret: creds.client_secret ?? "",
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`Google OAuth: ${json.error_description ?? json.error}`);
  if (!json.refresh_token) throw new Error("O Google não retornou refresh_token; remova o acesso do app na conta Google e conecte de novo");
  let email = "";
  if (json.id_token) {
    const payload = JSON.parse(Buffer.from(String(json.id_token).split(".")[1]!, "base64url").toString());
    email = payload.email ?? "";
  }
  if (userId) await savePersonalCredentials("google", userId, { refresh_token: json.refresh_token, email }, email || null);
  else await saveCredentials("google", { refresh_token: json.refresh_token, email });
  tokenCache.set(json.refresh_token, { token: json.access_token, exp: Date.now() + (json.expires_in - 60) * 1000 });
}

/** Token de acesso por conta (refresh_token): cada pessoa tem a sua; desconectar some com a credencial e o token não é mais achado. */
const tokenCache = new Map<string, { token: string; exp: number }>();

async function accessToken() {
  // de quem é a conta vem da conversa (getCredentials lê a pessoa atual)
  const creds = await getCredentials("google");
  if (!creds?.refresh_token) throw new Error("Google não está conectado para esta pessoa");
  const hit = tokenCache.get(creds.refresh_token);
  if (hit && hit.exp > Date.now()) return hit.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.client_id!,
      client_secret: creds.client_secret!,
      refresh_token: creds.refresh_token!,
      grant_type: "refresh_token",
    }),
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`Google: falha ao renovar token (${json.error})`);
  if (tokenCache.size > 500) tokenCache.clear();
  tokenCache.set(creds.refresh_token, { token: json.access_token, exp: Date.now() + (json.expires_in - 60) * 1000 });
  return json.access_token as string;
}

export async function googleApi(url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  if (!res.ok) throw new Error(`Google API ${res.status}: ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
  return json;
}
