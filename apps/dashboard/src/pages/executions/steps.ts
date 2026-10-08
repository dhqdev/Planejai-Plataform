/* Passos de uma execução: o formato que vem da API e as contas feitas em cima deles (sem React). */

export interface Step {
  id: number;
  parent_id: number | null;
  agent: string;
  type: string;
  name: string;
  model: string | null;
  status: string;
  input: any;
  output: any;
  error: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  duration_ms: number | null;
  started_at: string;
}

/** Filhos de cada passo (null = raiz). Passo com pai fora da lista sobe para a raiz. */
export type StepTree = Map<number | null, Step[]>;
export function stepTree(steps: Step[]): StepTree {
  const m: StepTree = new Map();
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    const k = s.parent_id != null && ids.has(s.parent_id) ? s.parent_id : null;
    m.set(k, [...(m.get(k) ?? []), s]);
  }
  return m;
}

/** Números do cabeçalho do detalhe: chamadas de IA, ações do time e modelos usados. */
export function stepTotals(steps: Step[]) {
  const llm = steps.filter((s) => s.type === "llm");
  return {
    llm: llm.length,
    actions: steps.filter((s) => s.type === "tool" || s.type === "delegate").length,
    models: [...new Set(llm.map((s) => s.model).filter(Boolean) as string[])],
  };
}

export interface AgentUsage { agent: string; actions: number; llm: number; cost: number; ms: number; errors: number }
/** Quanto cada agente trabalhou: o CTO primeiro, depois quem custou mais. */
export function teamUsage(steps: Step[]): AgentUsage[] {
  const m = new Map<string, AgentUsage>();
  for (const s of steps) {
    const r = m.get(s.agent) ?? { agent: s.agent, actions: 0, llm: 0, cost: 0, ms: 0, errors: 0 };
    if (s.type === "llm") {
      r.llm++;
      r.ms += Number(s.duration_ms ?? 0);
    } else if (s.type === "tool" || s.type === "delegate") r.actions++;
    r.cost += Number(s.cost_usd ?? 0);
    if (s.status === "error") r.errors++;
    m.set(s.agent, r);
  }
  return [...m.values()].sort((a, b) => (a.agent === "cto" ? -1 : b.agent === "cto" ? 1 : b.cost - a.cost));
}

/** Ferramentas usadas, na ordem em que apareceram, com quantas vezes e quantos erros. */
export function toolUsage(steps: Step[]): [string, { n: number; err: number }][] {
  const tools = new Map<string, { n: number; err: number }>();
  for (const s of steps) {
    if (s.type !== "tool") continue;
    const t = tools.get(s.name) ?? { n: 0, err: 0 };
    t.n++;
    if (s.status === "error") t.err++;
    tools.set(s.name, t);
  }
  return [...tools.entries()];
}
