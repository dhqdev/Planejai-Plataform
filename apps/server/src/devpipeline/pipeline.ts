import { Tracer } from "../agent/trace.js";
import { many, one, query } from "../db/pool.js";
import { getCredentials } from "../integrations/registry.js";
import { chatCompletion, LlmError } from "../llm/openrouter.js";
import { resolveModel } from "../llm/router.js";
import type { ChatMessage, ChatResult } from "../llm/types.js";
import { notify } from "../notifications.js";
import { getBoss, QUEUES } from "../queue/boss.js";
import { applyEdit, branchName, failureExcerpt, type FileEdit, lineDiff, parseModelJson, pathProblem } from "./edits.js";
import { Github, GithubError, parseRepo } from "./github.js";

/**
 * Esteira de desenvolvimento (só o dono): um chamado escrito no painel passa sozinho por
 *   fila → entendendo → planejando → codando → revisando → abrindo_pr → testando (→ corrigindo → testando) → pronto
 * Cada etapa é um job na fila `dev.pipeline` (uma por vez, na ordem) e cada chamada de modelo vai pelo OpenRouter,
 * aparece em Execuções (gatilho "esteira") e soma o custo em dev_ticket_steps para o painel de custos.
 * A esteira nunca escreve no branch base nem mescla: ela abre um PR em rascunho, espera o CI do próprio
 * repositório e, se ficar verde, tira do rascunho para o dono revisar e mesclar.
 */

export const INTEGRATION_ID = "esteira";

export const STAGE_LABEL: Record<string, string> = {
  fila: "Na fila",
  entendendo: "Entendendo o pedido",
  planejando: "Planejando",
  codando: "Escrevendo o código",
  revisando: "Revisando",
  abrindo_pr: "Abrindo o PR",
  testando: "Esperando os testes",
  corrigindo: "Corrigindo o que falhou",
  pronto: "Pronto para revisar",
  precisa_de_voce: "Precisa de você",
  falhou: "Falhou",
  cancelado: "Cancelado",
};

/**
 * O time da esteira: cada coluna do quadro é um agente com o próprio modelo (rota em Modelos).
 * Eles conversam entre si por recados curtos que ficam no card (dev_ticket_steps kind = 'msg').
 */
export const AGENTS: Record<string, { name: string; role: string; route: string }> = {
  lia: { name: "Lia", role: "Analista", route: "dev:refine" },
  beto: { name: "Beto", role: "Arquiteto", route: "dev:plan" },
  caio: { name: "Caio", role: "Desenvolvedor", route: "dev:code" },
  vera: { name: "Vera", role: "Revisora", route: "dev:review" },
  tito: { name: "Tito", role: "Testes", route: "dev:qa" },
};
export const STAGE_AGENT: Record<string, string> = {
  entendendo: "lia",
  planejando: "beto",
  codando: "caio",
  corrigindo: "caio",
  revisando: "vera",
  abrindo_pr: "tito",
  testando: "tito",
};

/** Etapas que rodam sozinhas (as outras param a esteira). */
const RUNNABLE = new Set(["fila", "entendendo", "planejando", "codando", "revisando", "abrindo_pr", "testando", "corrigindo"]);
export const FINAL = new Set(["pronto", "falhou", "cancelado", "precisa_de_voce"]);

/** Limites: o CI do repositório leva uns 10 min; até 2 rodadas de conserto e 1 de revisão. */
const MAX_FIX_ROUNDS = 2;
const MAX_REVIEW_ROUNDS = 1;
const CI_POLL_SECONDS = 60;
const CI_TIMEOUT_MIN = 45;
const NO_CI_MIN = 10;
const FILE_MAX = 60_000;
const CONTEXT_MAX = 160_000;
const DEFAULT_COST_CAP = 2;

export interface DevConfig {
  gh: Github;
  base: string;
  costCap: number;
}

export interface DevSettings {
  repo?: string;
  base_branch?: string;
  cost_cap?: string;
}

/** Ajustes salvos na própria tela Esteira (repositório, branch base, limite de custo). */
export async function devSettings(): Promise<DevSettings> {
  return ((await one("SELECT value FROM settings WHERE key = 'dev_pipeline'"))?.value ?? {}) as DevSettings;
}

export async function saveDevSettings(s: DevSettings) {
  const clean: DevSettings = {
    repo: String(s.repo ?? "").trim().slice(0, 200),
    base_branch: String(s.base_branch ?? "").trim().slice(0, 100),
    cost_cap: String(s.cost_cap ?? "").trim().slice(0, 10),
  };
  await query(
    "INSERT INTO settings (key, value, updated_at) VALUES ('dev_pipeline', $1, now()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()",
    [JSON.stringify(clean)],
  );
}

/**
 * Token: o da integração "Esteira de desenvolvimento" ou, se ela não foi preenchida, o do GitHub do dono
 * (Integrações > GitHub). Repositório: o da integração da esteira, o salvo na tela Esteira ou o padrão do GitHub.
 */
export async function devConfig(): Promise<(DevConfig & { tokenFrom: string }) | { missing: string; tokenFrom?: string; needRepo?: boolean }> {
  const own = await getCredentials(INTEGRATION_ID);
  const github = await getCredentials("github");
  const saved = await devSettings();
  const token = own?.token || github?.token;
  const tokenFrom = own?.token ? "Integrações > Esteira de desenvolvimento" : github?.token ? "Integrações > GitHub" : undefined;
  if (!token) return { missing: "Conecte o GitHub em Conexões > Integrações > GitHub (token com acesso ao repositório)." };
  const rawRepo = own?.repo || saved.repo || github?.default_repo;
  const repo = parseRepo(rawRepo);
  if (!repo) return { missing: rawRepo ? `Repositório "${rawRepo}" inválido: use dono/repositorio.` : "Falta dizer em qual repositório a esteira trabalha.", tokenFrom, needRepo: true };
  const cap = Number(String(own?.cost_cap || saved.cost_cap || "").replace(",", "."));
  return {
    gh: new Github(token, repo),
    base: (own?.base_branch || saved.base_branch || "main").trim(),
    costCap: Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_COST_CAP,
    tokenFrom: tokenFrom!,
  };
}

let checked: { at: number; key: string; problems: string[] } | null = null;

/** Situação para a tela: pronto de verdade só se o token pode escrever e ler o CI (conferido no GitHub, cache de 1 min). */
export async function devStatus(fresh = false) {
  const cfg = await devConfig();
  const settings = await devSettings();
  const base = { agents: AGENTS, stageAgent: STAGE_AGENT, stages: STAGE_LABEL, settings };
  if ("missing" in cfg) return { ...base, ready: false, missing: cfg.missing, tokenFrom: cfg.tokenFrom ?? null, needRepo: Boolean(cfg.needRepo), problems: [] as string[] };
  const key = `${cfg.tokenFrom}:${cfg.gh.repo.owner}/${cfg.gh.repo.name}`;
  if (fresh || !checked || checked.key !== key || Date.now() - checked.at > 60_000) {
    let problems: string[];
    try {
      problems = await cfg.gh.problems();
    } catch (err) {
      problems = [`Não deu para falar com o GitHub agora: ${err instanceof Error ? err.message : String(err)}`];
    }
    checked = { at: Date.now(), key, problems };
  }
  return {
    ...base,
    ready: !checked.problems.length,
    missing: checked.problems[0] ?? null,
    problems: checked.problems,
    tokenFrom: cfg.tokenFrom,
    needRepo: false,
    repo: `${cfg.gh.repo.owner}/${cfg.gh.repo.name}`,
    base: cfg.base,
    costCap: cfg.costCap,
  };
}

// ============================== chamados ==============================

export async function createTicket(t: { title: string; description: string; kind?: string }) {
  const kind = ["bug", "melhoria", "nova"].includes(t.kind ?? "") ? t.kind! : "melhoria";
  const row = await one<{ id: number }>("INSERT INTO dev_tickets (title, description, kind) VALUES ($1, $2, $3) RETURNING id", [
    t.title.trim().slice(0, 160),
    t.description.trim().slice(0, 8000),
    kind,
  ]);
  await enqueue(row!.id, "fila");
  return row!.id;
}

async function enqueue(ticketId: number, stage: string, startAfter = 0, attempt = 0) {
  await (await getBoss()).send(QUEUES.dev, { ticketId, stage, attempt }, { startAfter, retryLimit: 0, expireInSeconds: 30 * 60 });
}

async function setStage(id: number, stage: string, extra: Record<string, unknown> = {}) {
  const keys = Object.keys(extra);
  await query(
    `UPDATE dev_tickets SET stage = $2, stage_started_at = now(), updated_at = now(),
       finished_at = CASE WHEN $3::boolean THEN now() ELSE NULL END
       ${keys.map((k, i) => `, ${k} = $${i + 4}`).join("")} WHERE id = $1`,
    [id, stage, FINAL.has(stage), ...keys.map((k) => (extra[k] != null && typeof extra[k] === "object" ? JSON.stringify(extra[k]) : extra[k]))],
  );
  if (RUNNABLE.has(stage)) await enqueue(id, stage);
}

/** Dono pediu de novo: volta para a etapa em que parou (ou do começo). */
export async function retryTicket(id: number) {
  const t = await one("SELECT stage, failed_stage FROM dev_tickets WHERE id = $1", [id]);
  if (!t) return false;
  if (!["falhou", "cancelado", "precisa_de_voce"].includes(t.stage)) return false;
  await setStage(id, t.failed_stage && RUNNABLE.has(t.failed_stage) ? t.failed_stage : "entendendo", { error: null });
  return true;
}

export async function cancelTicket(id: number) {
  const r = await query("UPDATE dev_tickets SET stage = 'cancelado', failed_stage = stage, finished_at = now(), updated_at = now() WHERE id = $1 AND stage <> ALL($2)", [
    id,
    ["pronto", "cancelado"],
  ]);
  return (r.rowCount ?? 0) > 0;
}

/** Resposta do dono às perguntas do analista: entra no pedido e a esteira recomeça a entender. */
export async function answerTicket(id: number, text: string) {
  const t = await one("SELECT stage FROM dev_tickets WHERE id = $1", [id]);
  if (!t || !FINAL.has(t.stage) || t.stage === "pronto") return false;
  await query("UPDATE dev_tickets SET description = description || $2 WHERE id = $1", [id, `\n\nResposta do dono: ${text.trim().slice(0, 4000)}`]);
  await setStage(id, "entendendo", { error: null, review_rounds: 0 });
  return true;
}

// ============================== worker ==============================

/** Um job da fila: roda a etapa se o chamado ainda está nela (job repetido ou atrasado não faz nada). */
export async function runStage(job: { ticketId: number; stage: string; attempt?: number }) {
  const t = await one("SELECT * FROM dev_tickets WHERE id = $1", [job.ticketId]);
  if (!t || t.stage !== job.stage || !RUNNABLE.has(t.stage)) return;
  const cfg = await devConfig();
  if ("missing" in cfg) {
    await setStage(t.id, "falhou", { error: cfg.missing, failed_stage: t.stage });
    return;
  }
  if (t.stage === "fila") {
    await setStage(t.id, "entendendo");
    return;
  }
  if (Number(t.cost_usd) >= cfg.costCap) {
    await setStage(t.id, "falhou", { error: `Passou do limite de custo por chamado (US$ ${cfg.costCap}). Aumente em Integrações > Esteira e tente de novo.`, failed_stage: t.stage });
    return;
  }

  const run = new StageRun(t, cfg);
  try {
    const out = await STAGES[t.stage as keyof typeof STAGES](run);
    await run.tracer?.finish(out ?? STAGE_LABEL[t.stage] ?? t.stage);
  } catch (err) {
    await run.tracer?.error(err);
    const transient = (err instanceof LlmError && (!err.status || err.status === 429 || err.status >= 500)) || (err instanceof GithubError && err.status >= 500);
    if (transient && (job.attempt ?? 0) < 2) {
      await enqueue(t.id, t.stage, 60, (job.attempt ?? 0) + 1);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    await setStage(t.id, "falhou", { error: msg.slice(0, 2000), failed_stage: t.stage });
    await run.say(STAGE_AGENT[t.stage] ?? "tito", "dono", `Parei aqui: ${msg.slice(0, 600)}`).catch(() => {});
    await notify({ userId: null, kind: "esteira", title: `Esteira: #${t.id} parou`, body: `${t.title}: ${msg.slice(0, 300)}`, link: `/esteira?t=${t.id}` });
  }
}

/** Quem fala por cada rota (a mesma etapa pode chamar outro agente, ex.: o Beto responde o Caio). */
const TASK_AGENT: Record<string, string> = Object.fromEntries(Object.entries(AGENTS).map(([id, a]) => [a.route, id]));

/** Contexto de uma etapa: o chamado, a config e o registro de custo de cada chamada de modelo. */
class StageRun {
  /** execução em Execuções: só nasce na primeira chamada de modelo (a espera do CI não enche o log) */
  tracer: Tracer | null = null;
  constructor(public t: any, readonly cfg: DevConfig) {}

  /** Chamada de modelo com custo em Execuções e em dev_ticket_steps (o painel de custos lê daqui). */
  async llm(task: string, name: string, messages: ChatMessage[], summary?: (r: ChatResult) => string): Promise<ChatResult> {
    const choice = await resolveModel(task);
    this.tracer ??= await Tracer.start({ trigger: "esteira", input: `#${this.t.id} ${this.t.title} · ${STAGE_LABEL[this.t.stage]}`, noCharge: true });
    const agent = TASK_AGENT[task] ?? STAGE_AGENT[this.t.stage] ?? "esteira";
    const step = await this.tracer.step({ agent: `esteira:${agent}`, type: "llm", name, model: choice.model, input: messages.at(-1)?.content });
    const started = Date.now();
    let r: ChatResult;
    try {
      r = await chatCompletion(choice, { messages, responseFormat: { type: "json_object" } });
    } catch (err) {
      await step.fail(err);
      await this.record(name, { status: "error", summary: err instanceof Error ? err.message.slice(0, 300) : String(err), durationMs: Date.now() - started, model: choice.model, agent });
      throw err;
    }
    await step.ok(r.message.content, { model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd });
    await this.record(name, { model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd, durationMs: Date.now() - started, summary: summary?.(r), agent });
    return r;
  }

  /** Linha na linha do tempo do chamado (com ou sem modelo). */
  async record(name: string, s: { status?: string; model?: string; tokensIn?: number; tokensOut?: number; costUsd?: number; durationMs?: number; summary?: string; detail?: unknown; agent?: string }) {
    await query(
      `INSERT INTO dev_ticket_steps (ticket_id, stage, name, status, model, tokens_in, tokens_out, cost_usd, duration_ms, summary, detail, execution_id, agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [this.t.id, this.t.stage, name, s.status ?? "success", s.model ?? null, s.tokensIn ?? 0, s.tokensOut ?? 0, s.costUsd ?? 0, s.durationMs ?? 0, s.summary?.slice(0, 600) ?? null, s.detail == null ? null : JSON.stringify(s.detail), this.tracer?.executionId ?? null, s.agent ?? STAGE_AGENT[this.t.stage] ?? null],
    );
    if (s.costUsd || s.tokensIn || s.tokensOut) {
      await query("UPDATE dev_tickets SET cost_usd = cost_usd + $2, tokens_in = tokens_in + $3, tokens_out = tokens_out + $4, updated_at = now() WHERE id = $1", [
        this.t.id,
        s.costUsd ?? 0,
        s.tokensIn ?? 0,
        s.tokensOut ?? 0,
      ]);
    }
  }

  /** Recado de um agente para outro (ou para o "dono"): aparece como conversa no card. */
  async say(from: string, to: string, text: string | null | undefined) {
    const msg = String(text ?? "").trim();
    if (!msg) return;
    await query("INSERT INTO dev_ticket_steps (ticket_id, stage, name, kind, agent, to_agent, summary) VALUES ($1, $2, 'recado', 'msg', $3, $4, $5)", [
      this.t.id,
      this.t.stage,
      from,
      to,
      msg.slice(0, 2000),
    ]);
  }

  async next(stage: string, extra: Record<string, unknown> = {}) {
    await setStage(this.t.id, stage, extra);
  }

  async later(seconds: number) {
    await enqueue(this.t.id, this.t.stage, seconds);
  }
}

// ============================== contexto do repositório ==============================

const SKIP = /(^|\/)(node_modules|dist|build|coverage|\.git)\/|\.(png|jpe?g|gif|webp|ico|mp4|mp3|wav|ogg|woff2?|ttf|pdf|zip|lock)$|package-lock\.json$/;

async function repoContext(run: StageRun) {
  const { gh, base } = run.cfg;
  const sha = await gh.branchSha(base);
  const tree = (await gh.tree(sha)).filter((f) => !SKIP.test(f.path));
  const [rules, skill] = await Promise.all([gh.file("CLAUDE.md", sha), gh.file(".claude/skills/planejai/SKILL.md", sha)]);
  return { sha, tree, guide: [rules, skill].filter(Boolean).join("\n\n---\n\n").slice(0, 24_000) };
}

/** Lê os arquivos pedidos (só os que existem), até o teto de contexto. */
async function readFiles(run: StageRun, paths: string[], ref: string, known: Set<string>) {
  const out: { path: string; content: string }[] = [];
  let total = 0;
  for (const p of [...new Set(paths)].filter((p) => known.has(p)).slice(0, 20)) {
    const c = await run.cfg.gh.file(p, ref);
    if (c == null) continue;
    const content = c.length > FILE_MAX ? `${c.slice(0, FILE_MAX)}\n…(arquivo cortado em ${FILE_MAX} caracteres)` : c;
    if (total + content.length > CONTEXT_MAX) break;
    total += content.length;
    out.push({ path: p, content });
  }
  return out;
}

const filesBlock = (files: { path: string; content: string }[]) => files.map((f) => `=== ${f.path} ===\n${f.content}`).join("\n\n");

/** Título do analista quando é um título de verdade; senão o que o dono escreveu. */
const titleOf = (t: any): string => (String(t.spec?.titulo ?? "").trim().length > 3 ? String(t.spec.titulo).trim() : t.title);

const ticketBlock = (t: any) => `Chamado #${t.id} (${t.kind}): ${t.title}\n\n${t.description}`;
const specBlock = (s: any) =>
  s
    ? `Problema: ${s.problema}\nEsperado: ${s.esperado}\nCritérios de aceite:\n${(s.criterios ?? []).map((c: string) => `- ${c}`).join("\n")}${s.riscos?.length ? `\nRiscos: ${s.riscos.join("; ")}` : ""}`
    : "";

const EDIT_FORMAT = `Responda só com JSON:
{"resumo": "o que mudou, em 1-3 frases", "commit": "mensagem de commit curta em português",
 "arquivos": [
   {"path": "caminho/arquivo.ts", "action": "edit", "edits": [{"search": "trecho exato que existe hoje (copie igual, com espaços e quebras)", "replace": "trecho novo"}]},
   {"path": "caminho/novo.ts", "action": "create", "content": "arquivo inteiro"},
   {"path": "caminho/velho.ts", "action": "delete"}
 ]}
Regras das trocas: cada "search" aparece uma vez só no arquivo (inclua linhas vizinhas se precisar), troque o mínimo, mantenha o estilo do arquivo. Nada em .github/, .env, package-lock.json, nem migração que já existe (crie a próxima com número novo). Inclua ou ajuste teste quando fizer sentido.
Inclua também "recado": uma ou duas frases para a Vera (revisora) dizendo o que fez e onde olhar.`;

/** Recado dos colegas que veio antes, para cada agente ler como numa conversa. */
async function inbox(run: StageRun, to: string) {
  const rows = await many("SELECT agent, summary FROM dev_ticket_steps WHERE ticket_id = $1 AND kind = 'msg' AND to_agent = $2 ORDER BY id DESC LIMIT 4", [run.t.id, to]);
  return rows.length ? `\n\nRecados do time para você:\n${rows.reverse().map((r) => `- ${AGENTS[r.agent]?.name ?? r.agent}: ${r.summary}`).join("\n")}` : "";
}

// ============================== etapas ==============================

const STAGES = {
  fila: async () => "na fila",

  /** Analista: reescreve o pedido como problema + critérios de aceite e aponta os arquivos prováveis. */
  entendendo: async (run: StageRun) => {
    const ctx = await repoContext(run);
    const r = await run.llm(
      "dev:refine",
      "entender o pedido",
      [
        {
          role: "system",
          content:
            "Você é a Lia, analista de uma esteira de desenvolvimento automática (time: Lia analista, Beto arquiteto, Caio desenvolvedor, Vera revisora, Tito testes). Recebe um chamado do dono do produto e o descreve melhor para um desenvolvedor: problema, comportamento esperado, critérios de aceite verificáveis e os arquivos do repositório que provavelmente precisam mudar (só caminhos que existem na lista). Escreva em português do Brasil. Só faça perguntas se for impossível seguir sem a resposta; detalhe que dá para decidir, decida e diga qual escolheu.\n" +
            'Responda só com JSON: {"titulo": "...", "problema": "...", "esperado": "...", "criterios": ["..."], "arquivos": ["caminho"], "riscos": ["..."], "perguntas": ["..."], "bloqueado": false, "recado": "uma ou duas frases para o Beto (arquiteto): o que importa e onde começar"}',
        },
        { role: "user", content: `Guia do repositório:\n${ctx.guide}\n\nArquivos do repositório:\n${ctx.tree.map((f) => f.path).join("\n")}\n\n${ticketBlock(run.t)}` },
      ],
      (r) => parseModelJson(r.message.content)?.titulo ?? "",
    );
    const spec = parseModelJson(r.message.content);
    if (!spec?.problema) throw new Error("O analista não devolveu a descrição no formato esperado.");
    const known = new Set(ctx.tree.map((f) => f.path));
    spec.arquivos = (Array.isArray(spec.arquivos) ? spec.arquivos : []).filter((p: string) => known.has(p)).slice(0, 12);
    if (spec.bloqueado && spec.perguntas?.length) {
      await run.say("lia", "dono", `Antes de seguir preciso saber: ${spec.perguntas.join(" ")}`);
      await run.next("precisa_de_voce", { spec, failed_stage: "entendendo" });
      await notify({ userId: null, kind: "esteira", title: `Esteira: #${run.t.id} tem perguntas`, body: spec.perguntas.join(" "), link: `/esteira?t=${run.t.id}` });
      return `perguntas: ${spec.perguntas.join(" | ")}`;
    }
    await run.say("lia", "beto", spec.recado || `${spec.problema} Esperado: ${spec.esperado}`);
    await run.next("planejando", { spec });
    return spec.titulo ?? run.t.title;
  },

  /** Planejador: lê os arquivos apontados e decide o passo a passo e onde mexer. */
  planejando: async (run: StageRun) => {
    const ctx = await repoContext(run);
    const known = new Set(ctx.tree.map((f) => f.path));
    const files = await readFiles(run, run.t.spec?.arquivos ?? [], ctx.sha, known);
    const r = await run.llm(
      "dev:plan",
      "planejar a mudança",
      [
        {
          role: "system",
          content:
            "Você é o Beto, arquiteto da esteira: você planeja a mudança de código para um chamado que a Lia (analista) já descreveu. Leia os arquivos e diga exatamente o que mudar e onde, do jeito mais simples que cumpre os critérios de aceite, seguindo as regras do guia do repositório. Se precisar ler outros arquivos para codar, liste em \"ler\" (só caminhos que existem).\n" +
            'Responda só com JSON: {"passos": ["..."], "arquivos": [{"path": "...", "o_que": "..."}], "ler": ["caminho"], "testes": "como provar que funciona (teste a criar ou ajustar)", "recado": "uma ou duas frases para o Caio (desenvolvedor)"}',
        },
        {
          role: "user",
          content: `Guia do repositório:\n${ctx.guide}\n\nArquivos do repositório:\n${ctx.tree.map((f) => f.path).join("\n")}\n\n${ticketBlock(run.t)}\n\n${specBlock(run.t.spec)}${await inbox(run, "beto")}\n\nArquivos lidos:\n${filesBlock(files)}`,
        },
      ],
      (r) => `${parseModelJson(r.message.content)?.passos?.length ?? 0} passos`,
    );
    const plan = parseModelJson(r.message.content);
    if (!plan?.passos?.length) throw new Error("O planejador não devolveu o plano no formato esperado.");
    plan.ler = (Array.isArray(plan.ler) ? plan.ler : []).filter((p: string) => known.has(p)).slice(0, 10);
    await run.say("beto", "caio", plan.recado || plan.passos.join(" "));
    await run.next("codando", { plan });
    return plan.passos.join(" · ");
  },

  /** Desenvolvedor: escreve as trocas nos arquivos; trecho errado volta para ele uma vez com o erro. */
  codando: async (run: StageRun) => {
    const ctx = await repoContext(run);
    const known = new Set(ctx.tree.map((f) => f.path));
    const plan = run.t.plan ?? {};
    const wanted = [...(run.t.spec?.arquivos ?? []), ...(plan.arquivos ?? []).map((a: any) => a?.path), ...(plan.ler ?? [])].filter(Boolean);
    const files = await readFiles(run, wanted, ctx.sha, known);
    const review = run.t.review?.problemas?.length && !run.t.review.aprovado ? `\n\nO revisor recusou a versão anterior por:\n${run.t.review.problemas.map((p: string) => `- ${p}`).join("\n")}\nResolva esses pontos.` : "";
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `Você é o Caio, desenvolvedor da esteira. Implemente o plano do Beto (arquiteto) com a menor mudança correta, seguindo as regras do guia do repositório (textos para o usuário em português do Brasil, tom de WhatsApp).\n${EDIT_FORMAT}\nSe algo do plano estiver ambíguo a ponto de você não conseguir codar, em vez de arquivos responda só {"pergunta": "sua dúvida para o Beto"} (uma vez).`,
      },
      {
        role: "user",
        content: `Guia do repositório:\n${ctx.guide}\n\n${ticketBlock(run.t)}\n\n${specBlock(run.t.spec)}\n\nPlano:\n${(plan.passos ?? []).map((p: string) => `- ${p}`).join("\n")}\nOnde: ${(plan.arquivos ?? []).map((a: any) => `${a.path}: ${a.o_que}`).join("; ")}\nTestes: ${plan.testes ?? "-"}${review}${await inbox(run, "caio")}\n\nArquivos atuais:\n${filesBlock(files)}`,
      },
    ];
    const result = await writeChanges(run, messages, ctx.sha, known, "escrever o código", { canAsk: true, files, ctx });
    await run.say("caio", "vera", result.recado || result.resumo);
    await run.next("revisando", { changes: result.changes });
    return result.resumo;
  },

  /** Revisor: lê o diff contra os critérios. Recusou: volta uma vez para o desenvolvedor com os pontos. */
  revisando: async (run: StageRun) => {
    const diff = (run.t.changes?.files ?? []).map((f: any) => f.diff).join("\n\n").slice(0, 60_000);
    const r = await run.llm(
      "dev:review",
      "revisar o código",
      [
        {
          role: "system",
          content:
            "Você é a Vera, revisora da esteira: você revisa o diff do Caio (desenvolvedor) antes de virar PR. Recuse só por problema real: não cumpre um critério de aceite, quebra algo que já funciona, erro de tipo ou de lógica evidente, segredo no código, ou viola uma regra do guia. Estilo e gosto não são motivo.\n" +
            'Responda só com JSON: {"aprovado": true, "problemas": ["..."], "observacoes": "..."}',
        },
        { role: "user", content: `${ticketBlock(run.t)}\n\n${specBlock(run.t.spec)}${await inbox(run, "vera")}\n\nDiff:\n${diff}` },
      ],
      (r) => (parseModelJson(r.message.content)?.aprovado === false ? "pediu ajustes" : "aprovou"),
    );
    const review = parseModelJson(r.message.content) ?? { aprovado: true, problemas: [] };
    if (review.aprovado === false && review.problemas?.length && run.t.review_rounds < MAX_REVIEW_ROUNDS) {
      await run.say("vera", "caio", `Volta com isso, por favor: ${review.problemas.join(" ")}`);
      await run.next("codando", { review, review_rounds: run.t.review_rounds + 1 });
      return `pediu ajustes: ${review.problemas.join("; ")}`;
    }
    await run.say("vera", "tito", review.aprovado === false ? `Segue com ressalvas: ${review.problemas.join(" ")}` : review.observacoes || "Aprovado. Pode abrir o PR.");
    await run.next("abrindo_pr", { review });
    return review.aprovado === false ? "seguiu com ressalvas" : "aprovado";
  },

  /** Cria o branch esteira/<id>-<título>, faz o commit e abre o PR em rascunho. */
  abrindo_pr: async (run: StageRun) => {
    const { gh, base } = run.cfg;
    const t = run.t;
    const files = (t.changes?.files ?? []) as { path: string; content: string | null }[];
    if (!files.length) throw new Error("Nenhuma mudança para enviar.");
    const branch = t.branch ?? branchName(t.id, titleOf(t));
    const baseSha = await gh.branchSha(base);
    const exists = await gh.branchSha(branch).then(() => true, (e) => (e instanceof GithubError && e.status === 404 ? false : Promise.reject(e)));
    if (exists) throw new Error(`O branch ${branch} já existe no GitHub. Apague o branch ou cancele este chamado.`);
    const started = Date.now();
    const sha = await gh.commit(branch, baseSha, files.map((f) => ({ path: f.path, content: f.content })), `${t.changes?.commit || t.title} (esteira #${t.id})`, true);
    const pr = await gh.openPr({ branch, base, title: titleOf(t), body: prBody(t) });
    await run.record("abrir o PR", { durationMs: Date.now() - started, summary: `PR #${pr.number} em ${branch}`, detail: { url: pr.url, sha } });
    await run.say("tito", "dono", `Abri o PR #${pr.number} em rascunho. Agora espero o CI.`);
    await run.next("testando", { branch, pr_number: pr.number, pr_url: pr.url, head_sha: sha, ci: { since: new Date().toISOString() } });
    return pr.url;
  },

  /** Espera o CI do commit atual: verde tira do rascunho; vermelho manda o log para o conserto (até 2 vezes). */
  testando: async (run: StageRun) => {
    const { gh } = run.cfg;
    const t = run.t;
    const since = new Date(t.ci?.since ?? t.stage_started_at).getTime();
    const waited = (Date.now() - since) / 60_000;
    const runs = await gh.runs(t.head_sha);
    if (!runs.length) {
      if (waited < NO_CI_MIN) return run.later(CI_POLL_SECONDS).then(() => "esperando o CI começar");
      await run.record("testes", { summary: "O repositório não rodou CI neste PR: confira os testes à mão." });
      await run.say("tito", "dono", "O repositório não rodou CI neste PR. Confira os testes à mão antes de mesclar.");
      await run.next("pronto", { ci: { ...t.ci, status: "sem_ci" } });
      await finishReady(run, "sem CI");
      return "sem CI";
    }
    if (runs.some((r) => r.status !== "completed")) {
      if (waited > CI_TIMEOUT_MIN) throw new Error(`O CI passou de ${CI_TIMEOUT_MIN} minutos sem terminar.`);
      return run.later(CI_POLL_SECONDS).then(() => "testes rodando");
    }
    const bad = runs.filter((r) => !["success", "skipped", "neutral"].includes(r.conclusion ?? ""));
    if (!bad.length) {
      await run.record("testes", { durationMs: Date.now() - since, summary: `CI verde (${runs.map((r) => r.name).join(", ")})` });
      await run.say("tito", "dono", `CI verde. O PR #${t.pr_number} está pronto para você revisar e mesclar.`);
      await run.next("pronto", { ci: { ...t.ci, status: "verde", runs } });
      await finishReady(run, "CI verde");
      return "verde";
    }
    // vermelho: junta o trecho do log que explica a falha
    const excerpts: string[] = [];
    for (const r of bad.slice(0, 2)) {
      for (const j of (await gh.failedJobs(r.id)).slice(0, 2)) {
        const log = await gh.jobLog(j.id).catch(() => "");
        excerpts.push(`## ${r.name} / ${j.name}${j.failedStep ? ` (passo: ${j.failedStep})` : ""}\n${failureExcerpt(log)}`);
      }
    }
    const failure = excerpts.join("\n\n").slice(0, 16_000) || `Falhou: ${bad.map((r) => `${r.name} (${r.conclusion})`).join(", ")}`;
    await run.record("testes", { status: "error", durationMs: Date.now() - since, summary: `CI vermelho: ${bad.map((r) => r.name).join(", ")}`, detail: { log: failure, runs: bad } });
    if (t.fix_rounds >= MAX_FIX_ROUNDS) {
      await run.say("tito", "dono", `O CI continuou vermelho depois de ${MAX_FIX_ROUNDS} consertos. Deixei o PR para você olhar.`);
      await run.next("falhou", { ci: { ...t.ci, status: "vermelho", log: failure }, error: `O CI continuou vermelho depois de ${MAX_FIX_ROUNDS} consertos.`, failed_stage: "corrigindo" });
      await gh.comment(t.pr_number, `A esteira tentou consertar ${MAX_FIX_ROUNDS} vezes e o CI continua vermelho. Fica para revisão manual.\n\n---\n_Esteira de desenvolvimento do Planejai_`).catch(() => {});
      await notify({ userId: null, kind: "esteira", title: `Esteira: #${t.id} com teste vermelho`, body: t.title, link: `/esteira?t=${t.id}` });
      return "vermelho, sem mais consertos";
    }
    // o Tito lê o log e explica ao Caio o que quebrou (modelo barato; o Caio recebe também o log)
    const qa = await run.llm(
      "dev:qa",
      "explicar a falha do CI",
      [
        {
          role: "system",
          content:
            'Você é o Tito, de testes da esteira. Leia o log do CI e explique ao Caio (desenvolvedor), em até 3 frases, o que quebrou, em qual arquivo e a causa provável. Responda só com JSON: {"recado": "..."}',
        },
        { role: "user", content: `${specBlock(t.spec)}\n\nArquivos mudados: ${(t.changes?.files ?? []).map((f: any) => f.path).join(", ")}\n\nLog do CI:\n${failure}` },
      ],
      (r) => parseModelJson(r.message.content)?.recado ?? "",
    );
    await run.say("tito", "caio", parseModelJson(qa.message.content)?.recado || "O CI ficou vermelho, o log está anexo.");
    await run.next("corrigindo", { ci: { ...t.ci, status: "vermelho", log: failure } });
    return "vermelho";
  },

  /** Conserto: o desenvolvedor lê o log do CI e os arquivos do branch e faz um commit novo no mesmo PR. */
  corrigindo: async (run: StageRun) => {
    const { gh } = run.cfg;
    const t = run.t;
    const tree = (await gh.tree(t.head_sha)).filter((f) => !SKIP.test(f.path));
    const known = new Set(tree.map((f) => f.path));
    const log = String(t.ci?.log ?? "");
    const fromLog = [...known].filter((p) => log.includes(p) || log.includes(p.split("/").slice(-2).join("/")));
    const changed = (t.changes?.files ?? []).map((f: any) => f.path);
    const files = await readFiles(run, [...changed, ...fromLog], t.head_sha, known);
    const messages: ChatMessage[] = [
      { role: "system", content: `Você é o Caio, desenvolvedor da esteira, e conserta o CI vermelho do PR que o Tito (testes) apontou. Leia o log e os arquivos e faça a menor correção que deixa os testes verdes, sem desligar, pular ou apagar teste.\n${EDIT_FORMAT}` },
      { role: "user", content: `${ticketBlock(t)}\n\n${specBlock(t.spec)}${await inbox(run, "caio")}\n\nLog do CI:\n${log}\n\nArquivos do branch:\n${filesBlock(files)}` },
    ];
    const result = await writeChanges(run, messages, t.head_sha, known, "consertar o CI");
    const started = Date.now();
    const sha = await gh.commit(t.branch, t.head_sha, result.changes.files.map((f) => ({ path: f.path, content: f.content })), `${result.commit || "Conserta o CI"} (esteira #${t.id})`, false);
    await run.record("enviar o conserto", { durationMs: Date.now() - started, summary: `commit ${sha.slice(0, 7)}` });
    await run.say("caio", "tito", `Subi o conserto (${sha.slice(0, 7)}): ${result.recado || result.resumo}`);
    const merged = mergeChanges(t.changes, result.changes);
    await run.next("testando", { head_sha: sha, fix_rounds: t.fix_rounds + 1, changes: merged, ci: { since: new Date().toISOString() } });
    return result.resumo;
  },
};

/** Pede as trocas ao modelo, confere caminhos e aplica; se algum trecho não casar, devolve o erro ao modelo uma vez. */
async function writeChanges(
  run: StageRun,
  messages: ChatMessage[],
  ref: string,
  known: Set<string>,
  name: string,
  ask?: { canAsk: boolean; files: { path: string; content: string }[]; ctx: { guide: string } },
) {
  let asked = false;
  for (let round = 0; round < 2; round++) {
    const r = await run.llm("dev:code", round ? `${name} (2ª tentativa)` : name, messages, (r) => parseModelJson(r.message.content)?.resumo ?? parseModelJson(r.message.content)?.pergunta ?? "");
    const out = parseModelJson<{ resumo?: string; commit?: string; recado?: string; pergunta?: string; arquivos?: FileEdit[] }>(r.message.content);
    // dúvida do Caio: o Beto responde uma vez e o Caio tenta de novo (não conta como tentativa)
    if (ask?.canAsk && !asked && out?.pergunta && !out.arquivos?.length) {
      asked = true;
      round--;
      await run.say("caio", "beto", out.pergunta);
      const a = await run.llm(
        "dev:plan",
        "responder o Caio",
        [
          { role: "system", content: 'Você é o Beto, arquiteto da esteira. O Caio (desenvolvedor) ficou com uma dúvida sobre o seu plano. Responda direto, decidindo o que for preciso. Responda só com JSON: {"resposta": "..."}' },
          { role: "user", content: `Guia do repositório:\n${ask.ctx.guide}\n\n${ticketBlock(run.t)}\n\n${specBlock(run.t.spec)}\n\nSeu plano: ${(run.t.plan?.passos ?? []).join(" ")}\n\nPergunta do Caio: ${out.pergunta}\n\nArquivos:\n${filesBlock(ask.files)}` },
        ],
        (r) => parseModelJson(r.message.content)?.resposta ?? "",
      );
      const answer = parseModelJson(a.message.content)?.resposta || "Siga o plano do jeito mais simples.";
      await run.say("beto", "caio", answer);
      messages.push({ role: "assistant", content: r.message.content ?? "" }, { role: "user", content: `Resposta do Beto: ${answer}\nAgora mande o JSON com os arquivos.` });
      continue;
    }
    const problems: string[] = [];
    const files: { path: string; content: string | null; diff: string }[] = [];
    if (!out?.arquivos?.length) problems.push("Nenhum arquivo no JSON (campo arquivos vazio ou JSON inválido).");
    for (const e of out?.arquivos ?? []) {
      const bad = pathProblem(String(e?.path ?? ""), known);
      if (bad) {
        problems.push(`${e?.path}: ${bad}`);
        continue;
      }
      const current = known.has(e.path) ? await run.cfg.gh.file(e.path, ref) : null;
      const applied = applyEdit(current, e);
      if ("error" in applied) problems.push(applied.error);
      else files.push({ path: e.path, content: applied.content, diff: lineDiff(e.path, current, applied.content) });
    }
    if (!problems.length) return { resumo: out!.resumo ?? "", commit: out!.commit ?? "", recado: out!.recado ?? "", changes: { commit: out!.commit ?? "", resumo: out!.resumo ?? "", files } };
    await run.record(`${name}: trocas recusadas`, { status: "error", summary: problems.join(" | ").slice(0, 600) });
    messages.push({ role: "assistant", content: r.message.content ?? "" }, { role: "user", content: `Não deu para aplicar:\n${problems.map((p) => `- ${p}`).join("\n")}\nMande o JSON completo de novo, corrigido.` });
  }
  throw new Error("O modelo não conseguiu escrever trocas que se aplicam nos arquivos.");
}

/** Depois de um conserto, o diff mostrado no painel e usado em revisões é o do arquivo final. */
function mergeChanges(prev: any, next: { files: { path: string; content: string | null; diff: string }[] }) {
  const byPath = new Map<string, any>((prev?.files ?? []).map((f: any) => [f.path, f]));
  for (const f of next.files) byPath.set(f.path, { ...f, diff: byPath.has(f.path) ? `${byPath.get(f.path).diff}\n\n(conserto)\n${f.diff}` : f.diff });
  return { ...prev, files: [...byPath.values()] };
}

async function finishReady(run: StageRun, how: string) {
  const t = run.t;
  await run.cfg.gh.readyForReview(t.pr_number).catch(() => {});
  const cost = await one("SELECT cost_usd FROM dev_tickets WHERE id = $1", [t.id]);
  await run.cfg.gh
    .comment(t.pr_number, `Pronto para revisar (${how}). Custo da esteira neste chamado: US$ ${Number(cost?.cost_usd ?? 0).toFixed(4)}.\n\n---\n_Esteira de desenvolvimento do Planejai_`)
    .catch(() => {});
  await notify({ userId: null, kind: "esteira", title: `Esteira: PR #${t.pr_number} pronto para revisar`, body: titleOf(t), link: `/esteira?t=${t.id}` });
}

function prBody(t: any) {
  const s = t.spec ?? {};
  const plan = t.plan ?? {};
  return [
    `**Antes:** ${s.problema ?? t.description}`,
    "",
    `**Depois:** ${s.esperado ?? "-"}`,
    "",
    "### Critérios de aceite",
    ...(s.criterios ?? []).map((c: string) => `- [ ] ${c}`),
    "",
    "### Como",
    t.changes?.resumo || (plan.passos ?? []).join(" "),
    "",
    `Testes: ${plan.testes ?? "CI do repositório"}`,
    ...(t.review?.problemas?.length ? ["", `Ressalvas do revisor: ${t.review.problemas.join("; ")}`] : []),
    "",
    "<details><summary>Pedido original</summary>",
    "",
    t.description,
    "",
    "</details>",
    "",
    "---",
    `_Aberto pela esteira de desenvolvimento do Planejai (chamado #${t.id})._`,
  ].join("\n");
}

// ============================== painel ==============================

export async function listTickets() {
  return many(
    `SELECT id, title, kind, stage, failed_stage, pr_number, pr_url, branch, fix_rounds, error, cost_usd::float AS cost_usd,
            tokens_in, tokens_out, spec->>'titulo' AS spec_title, created_at, updated_at, stage_started_at, finished_at,
            (SELECT jsonb_build_object('agent', m.agent, 'to', m.to_agent, 'text', left(m.summary, 160)) FROM dev_ticket_steps m
              WHERE m.ticket_id = dev_tickets.id AND m.kind = 'msg' ORDER BY m.id DESC LIMIT 1) AS last_msg
       FROM dev_tickets ORDER BY created_at DESC LIMIT 200`,
  );
}

export async function getTicket(id: number) {
  const t = await one(
    `SELECT id, title, description, kind, stage, failed_stage, spec, plan, review, branch, pr_number, pr_url, head_sha, ci, fix_rounds,
            review_rounds, error, cost_usd::float AS cost_usd, tokens_in, tokens_out, created_at, updated_at, stage_started_at, finished_at,
            (SELECT jsonb_agg(jsonb_build_object('path', f->>'path', 'deleted', f->'content' = 'null'::jsonb, 'diff', left(f->>'diff', 20000)))
               FROM jsonb_array_elements(COALESCE(changes->'files', '[]'::jsonb)) f) AS files,
            changes->>'resumo' AS changes_summary
       FROM dev_tickets WHERE id = $1`,
    [id],
  );
  if (!t) return null;
  const steps = await many(
    `SELECT id, stage, name, status, kind, agent, to_agent, model, tokens_in, tokens_out, cost_usd::float AS cost_usd, duration_ms, summary, detail, execution_id, created_at
       FROM dev_ticket_steps WHERE ticket_id = $1 ORDER BY id`,
    [id],
  );
  return { ...t, steps };
}

/** Painel de custos: total, por etapa, por modelo, por dia e os chamados mais caros no período. */
export async function costOverview(days: number) {
  const d = Math.min(365, Math.max(1, Math.floor(days) || 30));
  const byAgent = await many(
    `SELECT agent, COALESCE(SUM(cost_usd), 0)::float AS cost, COUNT(*) FILTER (WHERE model IS NOT NULL)::int AS calls
       FROM dev_ticket_steps WHERE kind = 'step' AND agent IS NOT NULL AND created_at > now() - make_interval(days => $1) GROUP BY agent ORDER BY cost DESC`,
    [d],
  );
  const [total, byStage, byModel, byDay, top] = await Promise.all([
    one(
      `SELECT COALESCE(SUM(cost_usd), 0)::float AS cost, COALESCE(SUM(tokens_in), 0)::bigint AS tokens_in, COALESCE(SUM(tokens_out), 0)::bigint AS tokens_out,
              COUNT(*) FILTER (WHERE model IS NOT NULL)::int AS calls, COUNT(DISTINCT ticket_id)::int AS tickets
         FROM dev_ticket_steps WHERE created_at > now() - make_interval(days => $1)`,
      [d],
    ),
    many(
      `SELECT stage, COALESCE(SUM(cost_usd), 0)::float AS cost, COUNT(*) FILTER (WHERE model IS NOT NULL)::int AS calls,
              COUNT(DISTINCT ticket_id)::int AS tickets, ROUND(AVG(duration_ms))::int AS avg_ms, SUM(tokens_in)::bigint AS tokens_in, SUM(tokens_out)::bigint AS tokens_out
         FROM dev_ticket_steps WHERE created_at > now() - make_interval(days => $1) GROUP BY stage ORDER BY cost DESC`,
      [d],
    ),
    many(
      `SELECT model, COALESCE(SUM(cost_usd), 0)::float AS cost, COUNT(*)::int AS calls, SUM(tokens_in)::bigint AS tokens_in, SUM(tokens_out)::bigint AS tokens_out
         FROM dev_ticket_steps WHERE model IS NOT NULL AND created_at > now() - make_interval(days => $1) GROUP BY model ORDER BY cost DESC`,
      [d],
    ),
    many(
      `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, COALESCE(SUM(cost_usd), 0)::float AS cost
         FROM dev_ticket_steps WHERE created_at > now() - make_interval(days => $1) GROUP BY 1 ORDER BY 1`,
      [d],
    ),
    many(
      `SELECT t.id, t.title, t.stage, t.pr_number, SUM(s.cost_usd)::float AS cost
         FROM dev_ticket_steps s JOIN dev_tickets t ON t.id = s.ticket_id
        WHERE s.created_at > now() - make_interval(days => $1) GROUP BY t.id ORDER BY cost DESC LIMIT 10`,
      [d],
    ),
  ]);
  const done = await one(
    `SELECT COUNT(*) FILTER (WHERE stage = 'pronto')::int AS ready, COUNT(*) FILTER (WHERE stage = 'falhou')::int AS failed,
            COALESCE(AVG(cost_usd) FILTER (WHERE stage = 'pronto'), 0)::float AS avg_ready
       FROM dev_tickets WHERE created_at > now() - make_interval(days => $1)`,
    [d],
  );
  return { days: d, total, done, byAgent: byAgent.map((a) => ({ ...a, name: AGENTS[a.agent]?.name ?? a.agent, role: AGENTS[a.agent]?.role ?? "" })), byStage: byStage.map((s) => ({ ...s, label: STAGE_LABEL[s.stage] ?? s.stage })), byModel, byDay, top };
}
