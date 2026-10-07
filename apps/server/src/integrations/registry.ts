import { config } from "../config.js";
import { decryptJson, decryptJsonWithInfo, encryptJson } from "../crypto.js";
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
  category: "Produtividade" | "Comunicação" | "Pesquisa" | "Compras" | "Pagamentos" | "Infraestrutura";
  icon: string;
  docsUrl?: string;
  fields: IntegrationField[];
  /** conexão por OAuth (botão "Conectar com ...") em vez de colar token */
  oauth?: "google" | "mercadolivre";
  /** credenciais que podem vir do .env quando não configuradas no dashboard */
  envFallback?: () => Record<string, string> | null;
  test?: (creds: Record<string, string>) => Promise<string>;
}

async function okJson(res: Response, label: string) {
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${label} respondeu ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

const timed = (ms = 15_000) => AbortSignal.timeout(ms);

/** Cabeçalhos recomendados pela API REST do GitHub (versão fixada evita mudanças silenciosas). */
export const GH_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "User-Agent": "planejai",
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});

/**
 * Catálogo de integrações. Cada campo pedido aqui é exatamente o que as ferramentas usam
 * (nada a mais): o "help" diz onde pegar e quais permissões marcar.
 */
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
      {
        key: "client_id",
        label: "OAuth Client ID",
        type: "text",
        required: true,
        placeholder: "123...apps.googleusercontent.com",
        help: 'Google Cloud > APIs e serviços > Credenciais > Criar ID do cliente OAuth do tipo "Aplicativo da Web". Ative antes a Gmail API e a Google Calendar API.',
      },
      { key: "client_secret", label: "OAuth Client Secret", type: "password", required: true, placeholder: "GOCSPX-..." },
    ],
    test: async (c) => {
      if (!c.refresh_token) throw new Error("Falta autorizar: clique em Conectar com Google");
      return `Conectado como ${c.email || "conta Google"}`;
    },
  },
  {
    id: "notion",
    name: "Notion",
    description: "Buscar, ler e criar páginas e itens de bancos de dados.",
    category: "Produtividade",
    icon: "notion",
    docsUrl: "https://www.notion.so/profile/integrations",
    fields: [
      {
        key: "token",
        label: "Internal Integration Secret",
        type: "password",
        required: true,
        placeholder: "ntn_...",
        help: "Crie uma integração interna com Ler, Atualizar e Inserir conteúdo. Depois, em cada página que o assistente pode usar: ••• > Conexões > adicionar a integração.",
      },
      {
        key: "default_parent_page_id",
        label: "Página padrão para criar notas (opcional)",
        type: "text",
        placeholder: "id ou link da página",
        help: "Onde o assistente cria páginas quando você não diz o lugar.",
      },
    ],
    test: async (c) => {
      const j = await okJson(
        await fetch("https://api.notion.com/v1/users/me", { headers: { Authorization: `Bearer ${c.token}`, "Notion-Version": "2022-06-28" }, signal: timed() }),
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
    fields: [
      {
        key: "token",
        label: "Personal access token (fine-grained)",
        type: "password",
        required: true,
        placeholder: "github_pat_...",
        help: "Settings > Developer settings > Fine-grained tokens. Escolha os repositórios e dê Issues: Read and write e Pull requests: Read-only (Metadata: Read-only vem junto).",
      },
      { key: "default_repo", label: "Repositório padrão (opcional)", type: "text", placeholder: "dono/repositorio", help: "Usado quando você pede uma issue sem dizer o repositório." },
    ],
    test: async (c) => {
      const j = await okJson(await fetch("https://api.github.com/user", { headers: GH_HEADERS(c.token!), signal: timed() }), "GitHub");
      if (c.default_repo) {
        await okJson(await fetch(`https://api.github.com/repos/${c.default_repo}`, { headers: GH_HEADERS(c.token!), signal: timed() }), `GitHub (${c.default_repo})`);
      }
      return `Conectado como ${j.login}${c.default_repo ? ` · ${c.default_repo}` : ""}`;
    },
  },
  {
    id: "linear",
    name: "Linear",
    description: "Buscar e criar issues no Linear.",
    category: "Produtividade",
    icon: "linear",
    docsUrl: "https://linear.app/settings/account/security",
    fields: [
      { key: "api_key", label: "Personal API key", type: "password", required: true, placeholder: "lin_api_...", help: "Linear > Settings > Security & access > Personal API keys." },
      { key: "default_team_key", label: "Time padrão (opcional)", type: "text", placeholder: "ENG", help: "Sigla do time onde criar issues; sem ela usa o primeiro time." },
    ],
    test: async (c) => {
      const j = await okJson(
        await fetch("https://api.linear.app/graphql", {
          signal: timed(),
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
    fields: [
      {
        key: "bot_token",
        label: "Bot User OAuth Token",
        type: "password",
        required: true,
        placeholder: "xoxb-...",
        help: "api.slack.com/apps > seu app > OAuth & Permissions. Bot scopes: channels:read, channels:history, groups:read, groups:history, chat:write. Instale no workspace e convide o bot (/invite) nos canais.",
      },
    ],
    test: async (c) => {
      const j = await okJson(await fetch("https://slack.com/api/auth.test", { headers: { Authorization: `Bearer ${c.bot_token}` }, signal: timed() }), "Slack");
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
    fields: [{ key: "api_key", label: "API key", type: "password", required: true, placeholder: "tvly-...", help: "O plano grátis dá 1.000 buscas por mês." }],
    test: async (c) => {
      const j = await okJson(
        await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.api_key}` },
          body: JSON.stringify({ query: "teste", max_results: 1 }),
          signal: timed(),
        }),
        "Tavily",
      );
      return `Busca funcionando (${(j.results ?? []).length} resultado)`;
    },
  },
  {
    id: "brave",
    name: "Brave Search",
    description: "Busca na web alternativa à Tavily.",
    category: "Pesquisa",
    icon: "search",
    docsUrl: "https://api-dashboard.search.brave.com",
    fields: [{ key: "api_key", label: "API key (Search)", type: "password", required: true, placeholder: "BSA...", help: "Assine o plano Search (tem cota grátis) e copie a chave em API Keys." }],
    test: async (c) => {
      await okJson(
        await fetch("https://api.search.brave.com/res/v1/web/search?q=teste&count=1", { headers: { "X-Subscription-Token": c.api_key!, Accept: "application/json" }, signal: timed() }),
        "Brave",
      );
      return "Busca funcionando";
    },
  },
  {
    id: "browserless",
    name: "Navegador (Browserless)",
    description: "Navegador dos agentes: prints de páginas e pesquisa navegando no site, com gravação da tela em vídeo. Já vem na stack.",
    category: "Pesquisa",
    icon: "browser",
    docsUrl: "https://docs.browserless.io",
    fields: [
      { key: "url", label: "URL do Browserless", type: "url", required: true, placeholder: "http://browserless:3000" },
      { key: "token", label: "Token", type: "password", help: "O mesmo TOKEN configurado no serviço browserless da stack." },
    ],
    test: async (c) => {
      const base = c.url!.replace(/\/$/, "");
      const j = await okJson(await fetch(`${base}/json/version${c.token ? `?token=${encodeURIComponent(c.token)}` : ""}`, { signal: timed() }), "Browserless");
      return `Navegador pronto (${j.Browser ?? "Chromium"})`;
    },
    envFallback: () => (config.BROWSERLESS_URL ? { url: config.BROWSERLESS_URL, token: config.BROWSERLESS_TOKEN } : null),
  },
  {
    id: "mercadolivre",
    name: "Mercado Livre",
    description: "Busca produtos, compara preços, frete e reputação do vendedor para te ajudar a comprar.",
    category: "Compras",
    icon: "shop",
    oauth: "mercadolivre",
    docsUrl: "https://developers.mercadolivre.com.br/devcenter",
    fields: [
      {
        key: "client_id",
        label: "App ID (Client ID)",
        type: "text",
        required: true,
        placeholder: "1234567890123456",
        help: 'DevCenter > Criar aplicação. Marque os escopos "read" e "offline_access" e cadastre a URI de redirecionamento abaixo.',
      },
      { key: "client_secret", label: "Secret Key (Client Secret)", type: "password", required: true },
    ],
    test: async (c) => {
      if (!c.refresh_token) throw new Error("Falta autorizar: clique em Conectar com Mercado Livre");
      const { mercadolivreApi } = await import("./mercadolivre.js");
      const j = await mercadolivreApi("/users/me");
      return `Conectado como ${j.nickname}`;
    },
  },
  {
    id: "mercadopago",
    name: "Mercado Pago",
    description: "Gera links de pagamento (Pix, cartão, boleto) para cobrar ou pagar.",
    category: "Pagamentos",
    icon: "payment",
    docsUrl: "https://www.mercadopago.com.br/developers/panel/app",
    fields: [
      {
        key: "access_token",
        label: "Access token de produção",
        type: "password",
        required: true,
        placeholder: "APP_USR-...",
        help: "Suas integrações > sua aplicação > Credenciais de produção > Access Token. Só ele é necessário (a Public Key é para checkout no site, não usamos).",
      },
    ],
    test: async (c) => {
      const j = await okJson(await fetch("https://api.mercadopago.com/users/me", { headers: { Authorization: `Bearer ${c.access_token}` }, signal: timed() }), "Mercado Pago");
      return `Conectado como ${j.nickname ?? j.email}${String(c.access_token).startsWith("TEST-") ? " (credencial de teste)" : ""}`;
    },
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Gera links de checkout do Stripe.",
    category: "Pagamentos",
    icon: "payment",
    docsUrl: "https://dashboard.stripe.com/apikeys",
    fields: [
      {
        key: "secret_key",
        label: "Secret key ou Restricted key",
        type: "password",
        required: true,
        placeholder: "sk_live_... ou rk_live_...",
        help: "Recomendado: chave restrita só com Checkout Sessions: Write. Desenvolvedores > Chaves de API.",
      },
    ],
    test: async (c) => {
      const res = await fetch("https://api.stripe.com/v1/checkout/sessions?limit=1", { headers: { Authorization: `Bearer ${c.secret_key}` }, signal: timed() });
      await okJson(res, "Stripe");
      return `Conectado (${String(c.secret_key).includes("_live_") ? "produção" : "teste"})`;
    },
  },
  {
    id: "telegram",
    name: "Telegram",
    description: "Conversar com o assistente pelo Telegram. Cada pessoa conecta a conta dela em Minha conta > Conexões.",
    category: "Comunicação",
    icon: "send",
    docsUrl: "https://t.me/BotFather",
    fields: [
      {
        key: "bot_token",
        label: "Token do bot",
        type: "password",
        required: true,
        placeholder: "123456789:AA...",
        help: "No Telegram, fale com o @BotFather, mande /newbot, escolha nome e @ do bot e cole aqui o token que ele devolver.",
      },
    ],
    test: async (c) => {
      const res = await fetch(`https://api.telegram.org/bot${c.bot_token}/getMe`, { signal: timed() });
      const json = await okJson(res, "Telegram");
      return `Bot @${json.result?.username} conectado`;
    },
  },
  {
    id: "n8n",
    name: "n8n",
    description: "Suas automações do n8n: o assistente lista e dispara fluxos, o n8n manda mensagens e cria contas pela API interna e recebe eventos da plataforma.",
    category: "Infraestrutura",
    icon: "workflow",
    docsUrl: "https://docs.n8n.io/api/authentication/",
    fields: [
      { key: "base_url", label: "Endereço do n8n", type: "url", required: true, placeholder: "https://n8n.seudominio.com", help: "O mesmo endereço que você abre no navegador. Na mesma rede do Swarm pode ser http://n8n_n8n:5678." },
      { key: "api_key", label: "Chave da API do n8n", type: "password", required: true, help: "No n8n: Settings > n8n API > Create an API key." },
      { key: "webhook_user", label: "Usuário do Basic Auth dos webhooks (opcional)", type: "text", help: "Se seus webhooks usam Basic Auth, o assistente usa este usuário e senha ao disparar um fluxo." },
      { key: "webhook_password", label: "Senha do Basic Auth dos webhooks (opcional)", type: "password" },
      {
        key: "events_url",
        label: "Webhook de eventos (opcional)",
        type: "url",
        placeholder: "https://n8n.seudominio.com/webhook/planejai-eventos",
        help: "Um nó Webhook (POST) no n8n. A plataforma avisa nele quando entra cliente, sai gasto, estoura limite, dispara lembrete ou alguém conecta o Telegram.",
      },
    ],
    // n8n na mesma stack/rede: N8N_URL (ex.: http://n8n_n8n:5678) já liga eventos e disparos; com N8N_API_KEY também lista e cria fluxos
    envFallback: () =>
      config.N8N_URL
        ? {
            base_url: config.N8N_URL,
            ...(config.N8N_API_KEY ? { api_key: config.N8N_API_KEY } : {}),
            events_url: config.N8N_EVENTS_URL || `${config.N8N_URL.replace(/\/$/, "")}/webhook/planejai-eventos`,
          }
        : null,
    test: async (c) => {
      if (!c.api_key) return "Ligado pela stack (eventos e disparos). Para listar e criar fluxos, ponha N8N_API_KEY.";
      const res = await fetch(`${c.base_url.replace(/\/$/, "")}/api/v1/workflows?limit=250`, { headers: { "X-N8N-API-KEY": c.api_key, accept: "application/json" }, signal: timed() });
      const json = await okJson(res, "n8n");
      const list = json.data ?? [];
      return `Conectado: ${list.length} fluxo(s), ${list.filter((w: any) => w.active).length} ativo(s)`;
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
  // o que veio da stack (variáveis de ambiente) completa o que foi salvo na tela; o da tela vence
  if (!row || row.enabled) {
    const env = getDef(id)?.envFallback?.() ?? null;
    if (env) creds = creds ? { ...env, ...creds } : env;
  }
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
        redirectUri: d.oauth ? `${config.PUBLIC_URL.replace(/\/$/, "")}/api/integrations/${d.id}/oauth/callback` : null,
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

/**
 * Troca de chave sem perder integrações: no boot, credenciais que só abrem com a chave antiga
 * (ENCRYPTION_KEY_OLD ou o APP_SECRET legado) são gravadas de novo com a ENCRYPTION_KEY atual.
 */
export async function reencryptStale(log?: (msg: string) => void) {
  const rows = await many("SELECT id, credentials_enc FROM integrations WHERE credentials_enc IS NOT NULL");
  let n = 0;
  for (const r of rows) {
    try {
      const { value, stale } = decryptJsonWithInfo(r.credentials_enc);
      if (!stale) continue;
      await query("UPDATE integrations SET credentials_enc = $2 WHERE id = $1", [r.id, encryptJson(value)]);
      n++;
    } catch (err) {
      log?.(`credencial de ${r.id} não abriu com nenhuma chave: ${(err as Error).message}`);
    }
  }
  if (n) log?.(`${n} credencial(is) recriptografada(s) com a ENCRYPTION_KEY nova`);
  cache.clear();
}
