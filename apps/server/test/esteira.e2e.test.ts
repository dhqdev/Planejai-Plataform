import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Esteira de ponta a ponta com um GitHub falso em memória e o modelo simulado:
 * chamado → entende → planeja → coda (1ª troca errada volta para o modelo) → revisa → PR em rascunho
 * → CI vermelho → conserto num commit novo → CI verde → pronto. A main nunca muda.
 * E só o dono abre a esteira: cliente e outro super admin levam 403.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);

const replies: Record<string, string[]> = {};
vi.mock("../src/llm/openrouter.js", async (orig) => ({
  ...(await orig<typeof import("../src/llm/openrouter.js")>()),
  chatCompletion: vi.fn(async (_choice: any, req: any) => {
    const sys = String(req.messages[0].content);
    const key = sys.startsWith("Você é a Lia")
      ? "refine"
      : sys.startsWith("Você é o Beto, arquiteto da esteira: você planeja")
        ? "plan"
        : sys.startsWith("Você é o Beto")
          ? "answer"
          : sys.startsWith("Você é a Vera")
            ? "review"
            : sys.startsWith("Você é o Tito")
              ? "qa"
              : sys.includes("conserta")
                ? "fix"
                : "code";
    const content = replies[key]?.shift() ?? "{}";
    return { message: { content }, model: `fake/${key}`, tokensIn: 1000, tokensOut: 200, costUsd: 0.01, finishReason: "stop" };
  }),
}));
vi.mock("../src/integrations/registry.js", async (orig) => ({
  ...(await orig<typeof import("../src/integrations/registry.js")>()),
  getCredentials: vi.fn(async (id: string) => (id === "esteira" ? { token: "ghp_test", repo: "dono/app" } : null)),
}));

/** GitHub falso: commits guardam o mapa de arquivos inteiro. */
const gh = {
  commits: new Map<string, Record<string, string>>(),
  trees: new Map<string, Record<string, string>>(),
  refs: new Map<string, string>(),
  pulls: [] as any[],
  comments: [] as string[],
  ready: false,
  readOnly: false,
  noActions: false,
  ci: [] as ("failure" | "success")[],
  ciBySha: new Map<string, string>(),
  n: 0,
};
const ok = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
function resolve(ref: string) {
  return gh.commits.has(ref) ? ref : gh.refs.get(ref);
}
async function fakeGithub(url: string, init: RequestInit = {}) {
  const u = new URL(url);
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(String(init.body)) : null;
  const path = decodeURIComponent(u.pathname.replace(/^\/repos\/dono\/app/, ""));
  let m: RegExpMatchArray | null;
  if (path === "") return ok({ full_name: "dono/app", default_branch: "main", permissions: { push: !gh.readOnly } });
  if ((m = path.match(/^\/git\/ref\/heads\/(.+)$/))) return gh.refs.has(m[1]!) ? ok({ object: { sha: gh.refs.get(m[1]!) } }) : ok({ message: "Not Found" }, 404);
  if ((m = path.match(/^\/git\/trees\/(\w+)$/)) && method === "GET") return ok({ tree: Object.entries(gh.commits.get(m[1]!)!).map(([p, c]) => ({ path: p, type: "blob", size: c.length })) });
  if ((m = path.match(/^\/contents\/(.+)$/))) {
    const files = gh.commits.get(resolve(u.searchParams.get("ref")!)!)!;
    return m[1]! in files ? ok({ type: "file", content: Buffer.from(files[m[1]!]!).toString("base64") }) : ok({ message: "Not Found" }, 404);
  }
  if ((m = path.match(/^\/git\/commits\/(\w+)$/))) return ok({ tree: { sha: `tree-of-${m[1]}` } });
  if (path === "/git/trees" && method === "POST") {
    const files = { ...gh.commits.get(String(body.base_tree).replace("tree-of-", ""))! };
    for (const e of body.tree) {
      if (e.sha === null) delete files[e.path];
      else files[e.path] = e.content;
    }
    const sha = `t${++gh.n}`;
    gh.trees.set(sha, files);
    return ok({ sha });
  }
  if (path === "/git/commits" && method === "POST") {
    const sha = `c${++gh.n}`;
    gh.commits.set(sha, gh.trees.get(body.tree)!);
    return ok({ sha });
  }
  if (path === "/git/refs" && method === "POST") {
    gh.refs.set(String(body.ref).replace("refs/heads/", ""), body.sha);
    return ok({});
  }
  if ((m = path.match(/^\/git\/refs\/heads\/(.+)$/)) && method === "PATCH") {
    gh.refs.set(m[1]!, body.sha);
    return ok({});
  }
  if (path === "/pulls" && method === "POST") {
    gh.pulls.push(body);
    return ok({ number: 7, html_url: "https://github.com/dono/app/pull/7", node_id: "PR_7" });
  }
  if (path === "/pulls/7") return ok({ draft: !gh.ready, node_id: "PR_7" });
  if (u.pathname === "/graphql") {
    gh.ready = true;
    return ok({ data: {} });
  }
  if (path === "/issues/7/comments") {
    gh.comments.push(body.body);
    return ok({});
  }
  if (path === "/branches") return ok([...gh.refs.keys()].map((name) => ({ name })));
  if (path.startsWith("/actions") && gh.noActions) return ok({ message: "Resource not accessible by personal access token" }, 403);
  if (path === "/actions/runs" && !u.searchParams.get("head_sha")) return ok({ workflow_runs: [] });
  if (path === "/actions/runs") {
    const sha = u.searchParams.get("head_sha")!;
    if (!gh.ciBySha.has(sha)) gh.ciBySha.set(sha, gh.ci.shift() ?? "success");
    return ok({ workflow_runs: [{ id: 1, name: "CI", status: "completed", conclusion: gh.ciBySha.get(sha), html_url: "x" }] });
  }
  if (path === "/actions/runs/1/jobs") return ok({ jobs: [{ id: 11, name: "test", conclusion: "failure", steps: [{ name: "npm test", conclusion: "failure" }] }] });
  if (path === "/actions/jobs/11/logs") return ok("2026-10-15T10:00:00Z ok\n2026-10-15T10:00:01Z FAIL src/soma.test.ts > soma\nAssertionError: expected 3 to be 4\n");
  return ok({ message: `rota falsa sem resposta: ${method} ${path}` }, 500);
}

describe.skipIf(!enabled)("esteira de desenvolvimento (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let app: any;
  const realFetch = globalThis.fetch;
  const cookieOf = (res: any) => String(res.headers["set-cookie"]).split(";")[0]!;

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await db.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    const { buildServer } = await import("../src/api/server.js");
    app = await buildServer();
    vi.stubGlobal("fetch", (url: any, init?: any) => (String(url).startsWith("https://api.github.com") ? fakeGithub(String(url), init) : realFetch(url, init)));
    gh.commits.set("base", { "CLAUDE.md": "# Regras\nTextos em português.", "src/soma.ts": "export const soma = (a: number, b: number) => a - b;\n", "src/soma.test.ts": "expect(soma(1, 3)).toBe(4)\n" });
    gh.refs.set("main", "base");
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await (await import("../src/queue/boss.js")).stopBoss();
    await app?.close();
  });

  it("só o dono: cliente e outro super admin levam 403", async () => {
    const { hashPassword } = await import("../src/accounts.js");
    await db.query("INSERT INTO accounts (email, name, password_hash, role, status) VALUES ('sup@x.com', 'Sup', $1, 'superadmin', 'active'), ('cli@x.com', 'Cli', $1, 'admin', 'active')", [hashPassword("senha-forte-123")]);
    for (const email of ["sup@x.com", "cli@x.com"]) {
      const cookie = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "senha-forte-123" } }));
      for (const [method, url] of [["GET", "/api/dev/tickets"], ["GET", "/api/dev/costs"], ["POST", "/api/dev/tickets"], ["GET", "/api/dev/status"]] as const) {
        const r = await app.inject({ method, url, headers: { cookie }, payload: method === "POST" ? { title: "x", description: "y" } : undefined });
        expect(r.statusCode, `${email} ${url}`).toBe(403);
      }
    }
    expect((await app.inject({ method: "GET", url: "/api/dev/tickets" })).statusCode).toBe(401);
  });

  it("sem a integração da esteira, usa o token do GitHub e pede o repositório na tela; token sem escrita não fica pronto", async () => {
    const reg = await import("../src/integrations/registry.js");
    const owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } }));
    const creds = vi.mocked(reg.getCredentials);
    creds.mockImplementation(async (id: string) => (id === "github" ? { token: "ghp_only_read" } : null));
    let st = (await app.inject({ method: "GET", url: "/api/dev/status", headers: { cookie: owner } })).json();
    expect(st).toMatchObject({ ready: false, needRepo: true, tokenFrom: "Integrações > GitHub" });
    gh.readOnly = true;
    st = (await app.inject({ method: "PUT", url: "/api/dev/settings", headers: { cookie: owner }, payload: { repo: "https://github.com/dono/app" } })).json();
    expect(st.ready).toBe(false);
    expect(st.repo).toBe("dono/app");
    expect(st.problems[0]).toMatch(/Contents: Read and write/);
    gh.readOnly = false;
    st = (await app.inject({ method: "GET", url: "/api/dev/status?fresh=1", headers: { cookie: owner } })).json();
    expect(st.ready).toBe(true);
    // "Main" com maiúscula e token sem Actions: fica pronto, com a grafia certa e só um aviso
    gh.noActions = true;
    st = (await app.inject({ method: "PUT", url: "/api/dev/settings", headers: { cookie: owner }, payload: { repo: "dono/app", base_branch: "Main" } })).json();
    expect(st).toMatchObject({ ready: true, base: "main", problems: [] });
    expect(st.warnings[0]).toMatch(/Actions: Read-only/);
    st = (await app.inject({ method: "PUT", url: "/api/dev/settings", headers: { cookie: owner }, payload: { repo: "dono/app", base_branch: "develop" } })).json();
    expect(st.ready).toBe(false);
    expect(st.problems[0]).toMatch(/"develop" não existe/);
    gh.noActions = false;
    await app.inject({ method: "PUT", url: "/api/dev/settings", headers: { cookie: owner }, payload: { repo: "dono/app", base_branch: "main" } });
    creds.mockImplementation(async (id: string) => (id === "esteira" ? { token: "ghp_test", repo: "dono/app" } : null));
  });

  it("chamado vira PR, o CI vermelho é consertado e fica pronto sem tocar na main", async () => {
    const owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } }));
    const status = await app.inject({ method: "GET", url: "/api/dev/status", headers: { cookie: owner } });
    expect(status.json()).toMatchObject({ ready: true, repo: "dono/app", base: "main" });

    replies.refine = [JSON.stringify({ titulo: "Soma certa", problema: "soma subtrai", esperado: "soma soma", criterios: ["soma(1,3) = 4"], arquivos: ["src/soma.ts", "inventado.ts"], bloqueado: false })];
    replies.plan = [JSON.stringify({ passos: ["trocar - por +"], arquivos: [{ path: "src/soma.ts", o_que: "operador" }], ler: ["src/soma.test.ts"], testes: "soma.test.ts" })];
    replies.code = [
      // dúvida para o Beto: ele responde e o Caio segue
      JSON.stringify({ pergunta: "Troco o operador ou reescrevo a função?" }),
      // trecho que não existe → volta com o erro
      JSON.stringify({ resumo: "x", commit: "x", arquivos: [{ path: "src/soma.ts", action: "edit", edits: [{ search: "a * b", replace: "a + b" }] }] }),
      JSON.stringify({ resumo: "Troca o operador", commit: "Soma soma", arquivos: [{ path: "src/soma.ts", action: "edit", edits: [{ search: "a - b", replace: "a + b + 0" }] }] }),
    ];
    replies.answer = [JSON.stringify({ resposta: "Só troque o operador." })];
    replies.qa = [JSON.stringify({ recado: "O teste da soma esperava 4 e veio 3: o operador em src/soma.ts." })];
    replies.review = [JSON.stringify({ aprovado: true, problemas: [] })];
    replies.fix = [JSON.stringify({ resumo: "Tira o + 0", commit: "Conserta a soma", arquivos: [{ path: "src/soma.ts", action: "edit", edits: [{ search: "a + b + 0", replace: "a + b" }] }] })];
    gh.ci = ["failure", "success"];

    const created = await app.inject({ method: "POST", url: "/api/dev/tickets", headers: { cookie: owner }, payload: { title: "Soma errada", description: "A soma está subtraindo os números.", kind: "bug" } });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;

    const { runStage } = await import("../src/devpipeline/pipeline.js");
    const seen: string[] = [];
    for (let i = 0; i < 15; i++) {
      const t = await db.one("SELECT stage FROM dev_tickets WHERE id = $1", [id]);
      seen.push(t.stage);
      if (["pronto", "falhou", "precisa_de_voce", "cancelado"].includes(t.stage)) break;
      await runStage({ ticketId: id, stage: t.stage });
    }
    const t = await db.one("SELECT * FROM dev_tickets WHERE id = $1", [id]);
    expect(t.error).toBeNull();
    expect(seen).toEqual(["fila", "entendendo", "planejando", "codando", "revisando", "abrindo_pr", "testando", "corrigindo", "testando", "pronto"]);
    expect(t.spec.arquivos).toEqual(["src/soma.ts"]);
    expect(t.fix_rounds).toBe(1);
    expect(t.branch).toBe(`esteira/${id}-soma-certa`);
    expect(gh.refs.get("main")).toBe("base");
    expect(gh.commits.get(gh.refs.get(t.branch)!)!["src/soma.ts"]).toBe("export const soma = (a: number, b: number) => a + b;\n");
    expect(gh.pulls[0]).toMatchObject({ head: t.branch, base: "main", draft: true, title: "Soma certa" });
    expect(gh.pulls[0].body).toContain("**Antes:** soma subtrai");
    expect(gh.ready).toBe(true);
    expect(gh.comments.at(-1)).toMatch(/Pronto para revisar \(CI verde\)/);

    // 9 chamadas de modelo (refine, plan, code x3, answer, review, qa, fix) x US$ 0,01; a troca recusada e o CI viram passos sem custo
    const detail = (await app.inject({ method: "GET", url: `/api/dev/tickets/${id}`, headers: { cookie: owner } })).json();
    expect(detail.cost_usd).toBeCloseTo(0.09, 5);
    // a conversa do time fica no card, na ordem
    const talk = detail.steps.filter((s: any) => s.kind === "msg").map((s: any) => `${s.agent}>${s.to_agent}`);
    expect(talk).toEqual(["lia>beto", "beto>caio", "caio>beto", "beto>caio", "caio>vera", "vera>tito", "tito>dono", "tito>caio", "caio>tito", "tito>dono"]);
    expect(detail.steps.find((s: any) => s.agent === "beto" && s.to_agent === "caio" && s.summary === "Só troque o operador.")).toBeTruthy();
    expect(detail.steps.find((s: any) => s.name === "escrever o código").agent).toBe("caio");
    expect(detail.steps.map((s: any) => s.name)).toContain("escrever o código: trocas recusadas");
    expect(detail.steps.find((s: any) => s.name === "testes" && s.status === "error").detail.log).toContain("expected 3 to be 4");
    expect(detail.files[0].path).toBe("src/soma.ts");

    const costs = (await app.inject({ method: "GET", url: "/api/dev/costs?days=7", headers: { cookie: owner } })).json();
    expect(costs.total.cost).toBeCloseTo(0.09, 5);
    expect(costs.byAgent.find((a: any) => a.agent === "caio")).toMatchObject({ name: "Caio", calls: 4 });
    expect(costs.total.tickets).toBe(1);
    expect(costs.done.ready).toBe(1);
    expect(costs.byStage.find((s: any) => s.stage === "codando")).toMatchObject({ calls: 4, label: "Escrevendo o código" });
    expect(costs.byModel.map((m: any) => m.model).sort()).toEqual(["fake/answer", "fake/code", "fake/fix", "fake/plan", "fake/qa", "fake/refine", "fake/review"]);

    // aparece em Execuções com o gatilho da esteira, sem cobrar grão de ninguém
    const execs = await db.many("SELECT trigger, user_id FROM executions WHERE trigger = 'esteira'");
    expect(execs.length).toBe(6);
    expect(execs.every((e) => e.user_id === null)).toBe(true);
  });

  it("pedido vago para com perguntas e a resposta do dono faz recomeçar", async () => {
    const owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } }));
    replies.refine = [JSON.stringify({ titulo: "?", problema: "não dá para saber", esperado: "-", criterios: [], arquivos: [], perguntas: ["Qual tela?"], bloqueado: true })];
    const id = (await app.inject({ method: "POST", url: "/api/dev/tickets", headers: { cookie: owner }, payload: { title: "Arruma aquilo", description: "Aquilo lá não está bom." } })).json().id;
    const { runStage } = await import("../src/devpipeline/pipeline.js");
    await runStage({ ticketId: id, stage: "fila" });
    await runStage({ ticketId: id, stage: "entendendo" });
    expect((await db.one("SELECT stage FROM dev_tickets WHERE id = $1", [id])).stage).toBe("precisa_de_voce");
    const r = await app.inject({ method: "POST", url: `/api/dev/tickets/${id}/answer`, headers: { cookie: owner }, payload: { text: "A tela de Recados" } });
    expect(r.statusCode).toBe(200);
    const t = await db.one("SELECT stage, description FROM dev_tickets WHERE id = $1", [id]);
    expect(t.stage).toBe("entendendo");
    expect(t.description).toContain("Resposta do dono: A tela de Recados");
    expect((await app.inject({ method: "POST", url: `/api/dev/tickets/${id}/cancel`, headers: { cookie: owner } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/dev/tickets/${id}/retry`, headers: { cookie: owner } })).statusCode).toBe(200);
  });
});
