import { config } from "../config.js";
import { decryptJson, encryptJson } from "../crypto.js";
import { many, one, query } from "../db/pool.js";

export interface IntegrationField {
  key: string;
  label: string;
  type: "text" | "password" | "url";
  required?: boolean;
  placeholder?: string;
  help?: string;
}

export interface IntegrationDef {
  id: string;
  name: string;
  description: string;
  category: "Produtividade" | "Comunicação" | "Pesquisa" | "Pagamentos" | "Infraestrutura";
  icon: string;
  docsUrl?: string;
  fields: IntegrationField[];
  /** conexão por OAuth (botão "Conectar com ...") em vez de colar token */
  oauth?: "google";
  /** credenciais que podem vir do .env quando não configuradas no dashboard */
  envFallback?: () => Record<string, string> | null;
  test?: (creds: Record<string, string>) => Promise<string>;
}

async function okJson(res: Response, label: string) {
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${label} respondeu ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: "google",
    name: "Google Workspace",
    description: "Gmail e Google Agenda: ler, buscar e enviar e-mails; ver e criar eventos.",
    category: "Produtividade",
    icon: "google",
    oauth: "google",
    docsUrl: "https://console.cloud.google.com/apis/credentials",
    fields: [
      { key: "client_id", label: "OAuth Client ID", type: "text", required: true },
      { key: "client_secret", label: "OAuth Client Secret", type: "password", required: true },
    ],
  },
  {
    id: "notion",
    name: "Notion",
    description: "Buscar, ler e criar páginas e itens de bancos de dados.",
    category: "Produtividade",
    icon: "notion",
    docsUrl: "https://www.notion.so/profile/integrations",
    fields: [{ key: "token", label: "Internal Integration Secret", type: "password", required: true }],
    test: async (c) => {
      const j = await okJson(
        await fetch("https://api.notion.com/v1/users/me", { headers: { Authorization: `Bearer ${c.token}`, "Notion-Version": "2022-06-28" } }),
        "Notion",
      );
      return `Conectado como ${j.name ?? j.bot?.owner?.user?.name ?? "bot"}`;
    },
  },
  {
    id: "github",
    name: "GitHub",
    description: "Buscar e criar issues, ver PRs e repositórios.",
    category: "Produtividade",
    icon: "github",
    docsUrl: "https://github.com/settings/personal-access-tokens",
    fields: [{ key: "token", label: "Personal access token", type: "password", required: true }],
    test: async (c) => {
      const j = await okJson(await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${c.token}`, "User-Agent": "planejai" } }), "GitHub");
      return `Conectado como ${j.login}`;
    },
  },
  {
    id: "linear",
    name: "Linear",
    description: "Buscar e criar issues no Linear.",
    category: "Produtividade",
    icon: "linear",
    docsUrl: "https://linear.app/settings/account/security",
    fields: [{ key: "api_key", label: "API key", type: "password", required: true }],
    test: async (c) => {
      const j = await okJson(
        await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: { Authorization: c.api_key!, "Content-Type": "application/json" },
          body: JSON.stringify({ query: "{ viewer { name } }" }),
        }),
        "Linear",
      );
      if (j.errors?.length) throw new Error(`Linear: ${j.errors[0].message}`);
      return `Conectado como ${j.data?.viewer?.name}`;
    },
  },
  {
    id: "slack",
    name: "Slack",
    description: "Ler canais e enviar mensagens.",
    category: "Comunicação",
    icon: "slack",
    docsUrl: "https://api.slack.com/apps",
    fields: [{ key: "bot_token", label: "Bot User OAuth Token (xoxb-...)", type: "password", required: true }],
    test: async (c) => {
      const j = await okJson(await fetch("https://slack.com/api/auth.test", { headers: { Authorization: `Bearer ${c.bot_token}` } }), "Slack");
      if (!j.ok) throw new Error(`Slack: ${j.error}`);
      return `Conectado ao workspace ${j.team}`;
    },
  },
  {
    id: "tavily",
    name: "Tavily",
    description: "Busca na web otimizada para agentes (recomendado). Sem ela, a busca usa o plugin web do OpenRouter.",
    category: "Pesquisa",
    icon: "search",
    docsUrl: "https://app.tavily.com",
    fields: [{ key: "api_key", label: "API key", type: "password", required: true }],
  },
  {
    id: "brave",
    name: "Brave Search",
    description: "Busca na web alternativa à Tavily.",
    category: "Pesquisa",
    icon: "search",
    docsUrl: "https://api-dashboard.search.brave.com",
    fields: [{ key: "api_key", label: "API key", type: "password", required: true }],
  },
  {
    id: "browserless",
    name: "Navegador (Browserless)",
    description: "Tira prints de páginas (sessões de cinema, cardápios, preços) para mandar como foto no WhatsApp.",
    category: "Pesquisa",
    icon: "browser",
    docsUrl: "https://docs.browserless.io",
    fields: [
      { key: "url", label: "URL do Browserless", type: "url", required: true, placeholder: "http://browserless:3000" },
      { key: "token", label: "Token", type: "password" },
    ],
    envFallback: () => (config.BROWSERLESS_URL ? { url: config.BROWSERLESS_URL, token: config.BROWSERLESS_TOKEN } : null),
  },
  {
    id: "mercadopago",
    name: "Mercado Pago",
    description: "Gera links de pagamento (Pix, cartão, boleto) para cobrar ou pagar.",
    category: "Pagamentos",
    icon: "payment",
    docsUrl: "https://www.mercadopago.com.br/developers/panel/app",
    fields: [{ key: "access_token", label: "Access token", type: "password", required: true }],
    test: async (c) => {
      const j = await okJson(await fetch("https://api.mercadopago.com/users/me", { headers: { Authorization: `Bearer ${c.access_token}` } }), "Mercado Pago");
      return `Conectado como ${j.nickname ?? j.email}`;
    },
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Gera links de checkout do Stripe.",
    category: "Pagamentos",
    icon: "payment",
    docsUrl: "https://dashboard.stripe.com/apikeys",
    fields: [{ key: "secret_key", label: "Secret key", type: "password", required: true }],
    test: async (c) => {
      const j = await okJson(await fetch("https://api.stripe.com/v1/balance", { headers: { Authorization: `Bearer ${c.secret_key}` } }), "Stripe");
      return `Conectado (${j.livemode ? "produção" : "teste"})`;
    },
  },
];

const cache = new Map<string, { at: number; creds: Record<string, string> | null }>();

export function getDef(id: string) {
  return INTEGRATIONS.find((i) => i.id === id);
}

/** Credenciais decriptadas de uma integração conectada e habilitada (ou null). */
export async function getCredentials(id: string): Promise<Record<string, string> | null> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 10_000) return hit.creds;
  const row = await one("SELECT enabled, credentials_enc FROM integrations WHERE id = $1", [id]);
  let creds: Record<string, string> | null = null;
  if (row?.enabled && row.credentials_enc) creds = decryptJson(row.credentials_enc);
  // OAuth sem token ainda não está conectado
  if (creds && getDef(id)?.oauth && !creds.refresh_token) creds = null;
  if (!creds && (!row || row.enabled)) creds = getDef(id)?.envFallback?.() ?? null;
  cache.set(id, { at: Date.now(), creds });
  return creds;
}

export async function isConnected(id: string) {
  return (await getCredentials(id)) !== null;
}

export async function saveCredentials(id: string, creds: Record<string, string>, merge = true) {
  const current = merge ? await rawCredentials(id) : {};
  const next = { ...current, ...creds };
  await query(
    `INSERT INTO integrations (id, enabled, credentials_enc, connected_at, updated_at) VALUES ($1, true, $2, now(), now())
     ON CONFLICT (id) DO UPDATE SET credentials_enc = $2, enabled = true, connected_at = now(), updated_at = now()`,
    [id, encryptJson(next)],
  );
  cache.delete(id);
}

export async function rawCredentials(id: string): Promise<Record<string, string>> {
  const row = await one("SELECT credentials_enc FROM integrations WHERE id = $1", [id]);
  return row?.credentials_enc ? decryptJson(row.credentials_enc) : {};
}

export async function disconnect(id: string) {
  await query("DELETE FROM integrations WHERE id = $1", [id]);
  cache.delete(id);
}

export async function setEnabled(id: string, enabled: boolean) {
  await query("UPDATE integrations SET enabled = $2, updated_at = now() WHERE id = $1", [id, enabled]);
  cache.delete(id);
}

export async function listIntegrations() {
  const rows = await many("SELECT id, enabled, credentials_enc IS NOT NULL AS has_creds, connected_at FROM integrations");
  const byId = new Map(rows.map((r) => [r.id, r]));
  return Promise.all(
    INTEGRATIONS.map(async (d) => {
      const r = byId.get(d.id);
      const connected = await isConnected(d.id);
      return {
        id: d.id,
        name: d.name,
        description: d.description,
        category: d.category,
        icon: d.icon,
        docsUrl: d.docsUrl,
        oauth: d.oauth ?? null,
        fields: d.fields,
        connected,
        enabled: r?.enabled ?? true,
        source: r?.has_creds ? "dashboard" : connected ? "env" : null,
        connectedAt: r?.connected_at ?? null,
        // OAuth com client configurado mas ainda sem autorização
        pendingOAuth: Boolean(d.oauth && r?.has_creds && !connected),
      };
    }),
  );
}
