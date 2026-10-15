import { GH_HEADERS } from "../integrations/registry.js";

/**
 * Cliente mínimo da API do GitHub para a esteira. O host é fixo (api.github.com) e o repositório
 * vem da tela Integrações (validado em `parseRepo`), então nenhuma URL de usuário ou modelo chega aqui.
 * Escreve só em branches `esteira/...` criados pela própria esteira: nunca no branch base.
 */
const API = "https://api.github.com";

export interface RepoRef {
  owner: string;
  name: string;
}

export function parseRepo(raw: string | undefined): RepoRef | null {
  const m = String(raw ?? "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").match(/^([\w.-]{1,100})\/([\w.-]{1,100})$/);
  if (!m || [m[1], m[2]].some((p) => /^\.+$/.test(p!))) return null;
  return { owner: m[1]!, name: m[2]! };
}

export class GithubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class Github {
  constructor(private readonly token: string, readonly repo: RepoRef) {}

  private async call<T = any>(method: string, path: string, body?: unknown, opts: { raw?: boolean } = {}): Promise<T> {
    const url = path.startsWith("/repos/") || path === "/graphql" ? `${API}${path}` : `${API}/repos/${this.repo.owner}/${this.repo.name}${path}`;
    const res = await fetch(url, {
      method,
      headers: { ...GH_HEADERS(this.token), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (opts.raw) {
      if (!res.ok) throw new GithubError(`GitHub ${method} ${path} respondeu ${res.status}`, res.status);
      return (await res.text()) as T;
    }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new GithubError(`GitHub ${method} ${path} respondeu ${res.status}: ${String(json?.message ?? "").slice(0, 200)}`, res.status);
    return json as T;
  }

  async branchSha(branch: string): Promise<string> {
    const r = await this.call("GET", `/git/ref/heads/${encodeURIComponent(branch)}`);
    return r.object.sha;
  }

  /** Lista de arquivos do repositório (só caminhos de arquivo e tamanho). */
  async tree(sha: string): Promise<{ path: string; size: number }[]> {
    const r = await this.call("GET", `/git/trees/${sha}?recursive=1`);
    return (r.tree ?? []).filter((t: any) => t.type === "blob").map((t: any) => ({ path: t.path, size: t.size ?? 0 }));
  }

  /** Conteúdo de um arquivo em texto, ou null se não existe. */
  async file(path: string, ref: string): Promise<string | null> {
    try {
      const r = await this.call("GET", `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
      if (Array.isArray(r) || r.type !== "file") return null;
      return Buffer.from(String(r.content ?? ""), "base64").toString("utf8");
    } catch (err) {
      if (err instanceof GithubError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Um commit com vários arquivos (conteúdo novo; null apaga) em cima de `parent`. Cria o branch se ainda não existe,
   * senão avança o branch para o commit novo. Devolve o sha do commit.
   */
  async commit(branch: string, parent: string, files: { path: string; content: string | null }[], message: string, create: boolean): Promise<string> {
    const base = await this.call("GET", `/git/commits/${parent}`);
    const tree = await this.call("POST", "/git/trees", {
      base_tree: base.tree.sha,
      tree: files.map((f) => (f.content == null ? { path: f.path, mode: "100644", type: "blob", sha: null } : { path: f.path, mode: "100644", type: "blob", content: f.content })),
    });
    const commit = await this.call("POST", "/git/commits", { message, tree: tree.sha, parents: [parent] });
    if (create) await this.call("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: commit.sha });
    else await this.call("PATCH", `/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: false });
    return commit.sha;
  }

  async openPr(opts: { branch: string; base: string; title: string; body: string }): Promise<{ number: number; url: string; nodeId: string }> {
    const r = await this.call("POST", "/pulls", { head: opts.branch, base: opts.base, title: opts.title, body: opts.body, draft: true });
    return { number: r.number, url: r.html_url, nodeId: r.node_id };
  }

  async comment(pr: number, body: string) {
    await this.call("POST", `/issues/${pr}/comments`, { body });
  }

  /** Tira o PR de rascunho quando o CI passa (só existe na API GraphQL). */
  async readyForReview(pr: number) {
    const r = await this.call("GET", `/pulls/${pr}`);
    if (!r.draft) return;
    await this.call("POST", "/graphql", {
      query: "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
      variables: { id: r.node_id },
    });
  }

  /** Rodadas do GitHub Actions para um commit (precisa de Actions: Read no token). */
  async runs(sha: string): Promise<{ id: number; name: string; status: string; conclusion: string | null; url: string }[]> {
    const r = await this.call("GET", `/actions/runs?head_sha=${sha}&per_page=20`);
    return (r.workflow_runs ?? []).map((w: any) => ({ id: w.id, name: w.name, status: w.status, conclusion: w.conclusion, url: w.html_url }));
  }

  async failedJobs(runId: number): Promise<{ id: number; name: string; failedStep: string | null }[]> {
    const r = await this.call("GET", `/actions/runs/${runId}/jobs?per_page=50`);
    return (r.jobs ?? [])
      .filter((j: any) => j.conclusion === "failure")
      .map((j: any) => ({ id: j.id, name: j.name, failedStep: (j.steps ?? []).find((s: any) => s.conclusion === "failure")?.name ?? null }));
  }

  /** Log em texto de um job (o GitHub redireciona para um link temporário; o fetch segue sozinho). */
  async jobLog(jobId: number): Promise<string> {
    return this.call<string>("GET", `/actions/jobs/${jobId}/logs`, undefined, { raw: true });
  }
}
