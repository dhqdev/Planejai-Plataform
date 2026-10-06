import { config } from "../config.js";
import { getCredentials, rawCredentials, saveCredentials } from "./registry.js";

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

export async function googleExchangeCode(code: string) {
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
  await saveCredentials("google", { refresh_token: json.refresh_token, email });
  tokenCache = { token: json.access_token, exp: Date.now() + (json.expires_in - 60) * 1000 };
}

let tokenCache: { token: string; exp: number } | null = null;

async function accessToken() {
  const creds = await getCredentials("google");
  if (!creds) {
    tokenCache = null; // desconectado no dashboard: não reaproveita token antigo
    throw new Error("Google Workspace não está conectado");
  }
  if (tokenCache && tokenCache.exp > Date.now()) return tokenCache.token;
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
  tokenCache = { token: json.access_token, exp: Date.now() + (json.expires_in - 60) * 1000 };
  return tokenCache.token;
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
