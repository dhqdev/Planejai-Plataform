import { GH_HEADERS, getCredentials } from "../../integrations/registry.js";
import { writeLong } from "../writer.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

async function notion(path: string, body?: unknown, method = "POST") {
  const c = await getCredentials("notion");
  if (!c) throw new Error("Notion não conectado");
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${c.token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Notion ${res.status}: ${j.message ?? j.code ?? "erro"}`);
  return j;
}

const titleOf = (p: any) => {
  const props = p.properties ?? {};
  for (const v of Object.values<any>(props)) if (v?.type === "title") return v.title.map((t: any) => t.plain_text).join("");
  return p.title?.map((t: any) => t.plain_text).join("") ?? "";
};

export const notionSearch = defineTool<{ query: string }>({
  name: "notion_search",
  description: "Busca páginas e bancos de dados no Notion.",
  integration: "notion",
  parameters: obj({ query: { type: "string" } }, ["query"]),
  async run(args) {
    const j = await notion("/search", { query: args.query, page_size: 10 });
    return j.results.map((r: any) => ({ id: r.id, type: r.object, title: titleOf(r), url: r.url }));
  },
});

export const notionReadPage = defineTool<{ page_id: string }>({
  name: "notion_read_page",
  description: "Lê o texto de uma página do Notion.",
  integration: "notion",
  parameters: obj({ page_id: { type: "string" } }, ["page_id"]),
  async run(args) {
    const j = await notion(`/blocks/${args.page_id}/children?page_size=100`, undefined, "GET");
    const text = j.results
      .map((b: any) => (b[b.type]?.rich_text ?? []).map((t: any) => t.plain_text).join(""))
      .filter(Boolean)
      .join("\n");
    return { text: text.slice(0, 15_000) };
  },
});

/** Aceita id puro ou link do Notion e devolve o id (32 hex). */
export function notionId(v: string) {
  const m = v.replace(/-/g, "").match(/[0-9a-f]{32}(?=[^0-9a-f]*$)/i);
  return m ? m[0] : v;
}

export const notionCreatePage = defineTool<{ parent_page_id?: string; title: string; content?: string; brief?: string }>({
  name: "notion_create_page",
  description:
    "Cria uma página no Notion dentro de uma página pai (sem parent_page_id usa a página padrão configurada; use notion_search para achar outra). " +
    "Conteúdo curto: content. Conteúdo longo (plano, roteiro, resumo): mande só brief e a ferramenta escreve.",
  integration: "notion",
  parameters: obj(
    { parent_page_id: { type: "string" }, title: { type: "string" }, content: { type: "string" }, brief: { type: "string", description: "Em vez de content, para texto longo: o que a página deve ter" } },
    ["title"],
  ),
  async run(args, ctx) {
    const parent = args.parent_page_id ?? (await getCredentials("notion"))?.default_parent_page_id;
    if (!parent) return { error: "Diga em qual página criar (ou configure a página padrão na integração do Notion)." };
    const content =
      args.content?.trim() ||
      (args.brief?.trim()
        ? await writeLong(ctx, {
            name: "texto da página",
            system: "Você escreve o conteúdo de uma página do Notion em português do Brasil, a partir do pedido. Responda só o texto, um parágrafo ou item por linha, sem markdown pesado. Não invente dados.",
            ask: `Título: ${args.title}\nPedido: ${args.brief.trim()}`,
          })
        : "");
    const children = content
      .split(/\n+/)
      .filter(Boolean)
      .slice(0, 90)
      .map((line) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: line.slice(0, 1900) } }] } }));
    const j = await notion("/pages", {
      parent: { page_id: notionId(parent) },
      properties: { title: { title: [{ text: { content: args.title } }] } },
      children,
    });
    return { ok: true, id: j.id, url: j.url };
  },
});

async function github(path: string, init: RequestInit = {}) {
  const c = await getCredentials("github");
  if (!c) throw new Error("GitHub não conectado");
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { ...GH_HEADERS(c.token!), ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub: ${j.message}`);
  return j;
}

export const githubSearchIssues = defineTool<{ query: string }>({
  name: "github_search_issues",
  description: "Busca issues e PRs no GitHub (sintaxe de busca do GitHub, ex.: 'repo:dono/repo is:open is:pr').",
  integration: "github",
  parameters: obj({ query: { type: "string" } }, ["query"]),
  async run(args) {
    // A busca do GitHub exige is:issue ou is:pr na query (422 sem isso): sem o filtro, busca os dois e junta.
    const q = args.query.trim();
    const typed = /\b(is|type):(issue|pr|pull-request)\b/i.test(q);
    const queries = typed ? [q] : [`${q} is:issue`, `${q} is:pr`];
    const pages = await Promise.all(queries.map((x) => github(`/search/issues?q=${encodeURIComponent(x)}&per_page=15`)));
    return pages
      .flatMap((j) => j.items ?? [])
      .sort((a: any, b: any) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, 15)
      .map((i: any) => ({ number: i.number, title: i.title, state: i.state, url: i.html_url, pr: Boolean(i.pull_request), updated: i.updated_at }));
  },
});

export const githubCreateIssue = defineTool<{ repo?: string; title: string; body?: string; confirmed_by_user?: boolean }>({
  name: "github_create_issue",
  description: "Cria uma issue num repositório (repo no formato dono/nome; sem repo usa o padrão configurado). Fora do repositório padrão, só depois do \"sim\".",
  integration: "github",
  parameters: obj({ repo: { type: "string" }, title: { type: "string" }, body: { type: "string" }, ...CONFIRM_PARAM }, ["title"]),
  async run(args, ctx) {
    const fallback = (await getCredentials("github"))?.default_repo;
    const repo = (args.repo ?? fallback ?? "").trim();
    if (!repo) return { error: "Diga em qual repositório (dono/nome) ou configure o repositório padrão na integração do GitHub." };
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split("/").some((p) => /^\.+$/.test(p))) return { ok: false, error: `Repositório inválido: ${repo}. Use dono/nome.` };
    // publicar em nome da pessoa num repositório que não é o dela (inclusive público de terceiros) pede o sim
    if (repo.toLowerCase() !== String(fallback ?? "").toLowerCase()) {
      const c = await requireConfirmation(args, `criar a issue "${args.title}" em ${repo}`, ctx);
      if (c) return c;
    }
    const j = await github(`/repos/${repo}/issues`, { method: "POST", body: JSON.stringify({ title: args.title, body: args.body }) });
    return { ok: true, number: j.number, url: j.html_url };
  },
});

async function linear(queryText: string, variables: Record<string, unknown> = {}) {
  const c = await getCredentials("linear");
  if (!c) throw new Error("Linear não conectado");
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: c.api_key!, "Content-Type": "application/json" },
    body: JSON.stringify({ query: queryText, variables }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (j.errors?.length) throw new Error(`Linear: ${j.errors[0]?.message}`);
  if (!res.ok || !j.data) throw new Error(`Linear respondeu ${res.status}`);
  return j.data;
}

export const linearSearchIssues = defineTool<{ query: string }>({
  name: "linear_search_issues",
  description: "Busca issues no Linear por texto.",
  integration: "linear",
  parameters: obj({ query: { type: "string" } }, ["query"]),
  async run(args) {
    const d = await linear(
      `query($q: String!) { searchIssues(term: $q, first: 15) { nodes { identifier title url state { name } assignee { name } } } }`,
      { q: args.query },
    );
    return d.searchIssues.nodes;
  },
});

export const linearCreateIssue = defineTool<{ title: string; description?: string; team_key?: string }>({
  name: "linear_create_issue",
  description: "Cria uma issue no Linear (team_key opcional, ex.: ENG; padrão: primeiro time).",
  integration: "linear",
  parameters: obj({ title: { type: "string" }, description: { type: "string" }, team_key: { type: "string" } }, ["title"]),
  async run(args) {
    const teams = (await linear(`{ teams { nodes { id key name } } }`)).teams.nodes;
    const key = args.team_key ?? (await getCredentials("linear"))?.default_team_key;
    const team = teams.find((t: any) => t.key?.toLowerCase() === key?.toLowerCase()) ?? teams[0];
    if (!team) throw new Error("Nenhum time no Linear");
    const d = await linear(
      `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { identifier url } } }`,
      { input: { teamId: team.id, title: args.title, description: args.description } },
    );
    return { ok: true, ...d.issueCreate.issue };
  },
});
