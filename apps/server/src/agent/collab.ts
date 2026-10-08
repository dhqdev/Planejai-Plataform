import type { ChatMessage } from "../llm/types.js";
import { one, query } from "../db/pool.js";
import type { BrowserSession } from "./browser.js";
import { getSettings } from "../settings.js";
import { specialistSystemPrompt } from "./prompts.js";
import { availableTools, isOwnerOnly, runToolLoop } from "./runner.js";
import { isOwner } from "../ingest.js";
import { SPECIALISTS, type AgentDef } from "./team.js";
import { defineTool, obj, type Tool, type ToolContext } from "./tools/types.js";

/** Profundidade máxima de conversa: CTO -> especialista -> colega. */
const MAX_CHAIN = 3;

/**
 * Sala do time durante uma execução. É aqui que os agentes conversam:
 * - cada especialista tem uma conversa contínua com o CTO (o CTO pode voltar, cobrar, pedir ajuste);
 * - especialistas consultam colegas diretamente (consult_<colega>);
 * - um quadro compartilhado guarda o que cada um descobriu, e todo mundo lê antes de agir.
 *
 * O time é o desta pessoa: os especialistas fixos mais os agentes sob medida dela, que conversam entre si do mesmo jeito.
 */
export class TeamRoom {
  /** quem está no time nesta execução (um agente criado no meio da conversa entra aqui na hora) */
  team: AgentDef[];
  threads = new Map<string, ChatMessage[]>();
  board: { from: string; note: string }[] = [];
  /** quem conversou com quem, para o log/canvas */
  edges: { from: string; to: string }[] = [];
  /** ferramentas que rodaram com sucesso nesta execução (trava: não dizer que fez o que não fez) */
  done = new Set<string>();
  /** navegador ("computador") aberto nesta execução, compartilhado pelo time */
  browser?: BrowserSession;
  private locks = new Map<string, Promise<unknown>>();

  constructor(team: AgentDef[] = SPECIALISTS) {
    this.team = [...team];
  }

  nameOf(id: string) {
    return id === "cto" ? "CTO" : (this.team.find((a) => a.id === id)?.name ?? id);
  }

  /** Serializa as conversas do CTO com um mesmo especialista (pedidos em paralelo entram na fila). */
  async withLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(agentId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(agentId, run.catch(() => {}));
    return run;
  }

  boardText(): string {
    if (!this.board.length) return "";
    return `\n\nQuadro do time (o que os colegas já descobriram nesta tarefa):\n${this.board.map((b) => `- ${this.nameOf(b.from)}: ${b.note}`).join("\n")}`;
  }
}

function shareTool(): Tool<{ note: string }> {
  return defineTool({
    name: "share_with_team",
    description: "Anota no quadro do time uma descoberta útil para os colegas (ex.: 'sessões confirmadas no Kinoplex: 14h30, 16h30').",
    parameters: obj({ note: { type: "string" } }, ["note"]),
    async run(args, ctx) {
      ctx.room.board.push({ from: ctx.agent, note: args.note.slice(0, 1000) });
      return { ok: true };
    },
  });
}

async function toolsFor(def: AgentDef, chain: string[], ctx: ToolContext) {
  const own = await availableTools(def.tools, ctx.user);
  const peers = chain.length < MAX_CHAIN ? ctx.room.team.filter((s) => s.id !== def.id && !chain.includes(s.id)).map(consultTool) : [];
  return { own, all: [...own, ...peers, shareTool()] };
}

async function systemFor(def: AgentDef, ctx: ToolContext, own: Tool[]) {
  const settings = await getSettings();
  const owner = isOwner(ctx.user.phone);
  const missing = [...new Set(def.tools.filter((t) => t.integration && !own.includes(t) && (owner || !isOwnerOnly(t))).map((t) => t.integration!))];
  return (
    specialistSystemPrompt(def, {
      timezone: ctx.timezone,
      user: ctx.user,
      settings,
      note: (await one("SELECT note FROM agent_notes WHERE user_id = $1 AND agent = $2", [ctx.user.id, def.id]).catch(() => null))?.note,
    }) +
    (missing.length ? `\n\n(Integrações não conectadas para você: ${missing.join(", ")})` : "")
  );
}

/** ask_<especialista>: conversa contínua do CTO com um especialista durante a execução. */
export function delegationTool(def: AgentDef): Tool<{ message: string }> {
  return defineTool({
    name: `ask_${def.id}`,
    description:
      `${def.name}: ${def.role} ` +
      "É uma conversa: chamar de novo continua de onde parou (use para cobrar, corrigir ou pedir mais). Mande a tarefa completa na primeira vez.",
    parameters: obj({ message: { type: "string", description: "Tarefa ou resposta para o especialista, com todo o contexto necessário" } }, ["message"]),
    async run(args, ctx) {
      return ctx.room.withLock(def.id, async () => {
        const chain = [...ctx.callChain, def.id];
        const { own, all } = await toolsFor(def, chain, ctx);
        const known = ctx.room.threads.get(def.id);
        const thread = known ?? [{ role: "system", content: await systemFor(def, ctx, own) } as ChatMessage];
        // chegou foto/documento nesta rodada: o especialista vê a mensagem já interpretada, não só o resumo do CTO
        const withMedia = Boolean(ctx.inboundImages?.length || ctx.inboundFiles?.length);
        const original = !known && withMedia && ctx.inboundText ? `\n\n[Mensagem da pessoa, com a mídia já descrita]\n${ctx.inboundText}` : "";
        thread.push({ role: "user", content: `[CTO] ${args.message}${original}${ctx.room.boardText()}` });
        ctx.room.edges.push({ from: ctx.agent, to: def.id });
        if (def.clientAgentId) void query("UPDATE client_agents SET uses = uses + 1 WHERE id = $1", [def.clientAgentId]).catch(() => {});
        const r = await runToolLoop({ agent: def.id, task: def.task ?? `agent:${def.id}`, ctx: { ...ctx, agent: def.id, callChain: chain }, tools: all, maxSteps: 7, messages: thread });
        ctx.room.threads.set(def.id, r.messages);
        return { report: r.text || "(o especialista não retornou relatório)" };
      });
    },
  });
}

/** Primeira frase do papel (até 160 caracteres), para a descrição da consult_ não repetir o papel inteiro. */
function shortRole(role: string) {
  const first = role.split(/(?<=[.!?])\s/)[0] ?? role;
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

/** consult_<colega>: um especialista pergunta algo direto para outro, sem passar pelo CTO. */
export function consultTool(def: AgentDef): Tool<{ question: string }> {
  return defineTool({
    name: `consult_${def.id}`,
    // só a primeira frase do papel: cada especialista recebe uma consult_ por colega em toda chamada, e isso é pago como entrada
    description: `Pergunte ao colega ${def.name} (${shortRole(def.role)}) algo da área dele. Seja específico e dê o contexto. Chamar de novo continua a conversa.`,
    parameters: obj({ question: { type: "string" } }, ["question"]),
    async run(args, ctx) {
      const chain = [...ctx.callChain, def.id];
      if (ctx.callChain.includes(def.id) || chain.length > MAX_CHAIN) {
        return { error: `Não dá para consultar ${def.name} agora (já está nesta cadeia de conversa). Resolva com o que tem ou devolva ao CTO.` };
      }
      // Consulta entre colegas usa uma conversa própria (não trava a conversa do CTO com o mesmo agente).
      // A mesma dupla volta a conversar de onde parou: o prompt do colega não é montado e pago de novo a cada pergunta.
      const key = `consult:${ctx.agent}>${def.id}`;
      return ctx.room.withLock(key, async () => {
        const { own, all } = await toolsFor(def, chain, ctx);
        ctx.room.edges.push({ from: ctx.agent, to: def.id });
        if (def.clientAgentId) void query("UPDATE client_agents SET uses = uses + 1 WHERE id = $1", [def.clientAgentId]).catch(() => {});
        const thread = ctx.room.threads.get(key) ?? [{ role: "system", content: await systemFor(def, ctx, own) } as ChatMessage];
        thread.push({ role: "user", content: `[${ctx.room.nameOf(ctx.agent)}, seu colega de time, pergunta] ${args.question}${ctx.room.boardText()}` });
        const r = await runToolLoop({
          agent: def.id,
          task: def.task ?? `agent:${def.id}`,
          ctx: { ...ctx, agent: def.id, callChain: chain },
          tools: all,
          maxSteps: 5,
          messages: thread,
        });
        ctx.room.threads.set(key, r.messages);
        return { answer: r.text || "(sem resposta)" };
      });
    },
  });
}
