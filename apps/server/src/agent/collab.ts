import type { ChatMessage } from "../llm/types.js";
import type { BrowserSession } from "./browser.js";
import { getSettings } from "../settings.js";
import { specialistSystemPrompt } from "./prompts.js";
import { availableTools, runToolLoop } from "./runner.js";
import { SPECIALISTS, type AgentDef } from "./team.js";
import { defineTool, obj, type Tool, type ToolContext } from "./tools/types.js";

/** Profundidade máxima de conversa: CTO -> especialista -> colega. */
const MAX_CHAIN = 3;

const NAMES: Record<string, string> = { cto: "CTO" };
for (const s of SPECIALISTS) NAMES[s.id] = s.name;

/**
 * Sala do time durante uma execução. É aqui que os agentes conversam:
 * - cada especialista tem uma conversa contínua com o CTO (o CTO pode voltar, cobrar, pedir ajuste);
 * - especialistas consultam colegas diretamente (consult_<colega>);
 * - um quadro compartilhado guarda o que cada um descobriu, e todo mundo lê antes de agir.
 */
export class TeamRoom {
  threads = new Map<string, ChatMessage[]>();
  board: { from: string; note: string }[] = [];
  /** quem conversou com quem, para o log/canvas */
  edges: { from: string; to: string }[] = [];
  /** navegador ("computador") aberto nesta execução, compartilhado pelo time */
  browser?: BrowserSession;
  private locks = new Map<string, Promise<unknown>>();

  /** Serializa as conversas do CTO com um mesmo especialista (pedidos em paralelo entram na fila). */
  async withLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(agentId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(agentId, run.catch(() => {}));
    return run;
  }

  boardText(): string {
    if (!this.board.length) return "";
    return `\n\nQuadro do time (o que os colegas já descobriram nesta tarefa):\n${this.board.map((b) => `- ${NAMES[b.from] ?? b.from}: ${b.note}`).join("\n")}`;
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

async function toolsFor(def: AgentDef, chain: string[]) {
  const own = await availableTools(def.tools);
  const peers = chain.length < MAX_CHAIN ? SPECIALISTS.filter((s) => s.id !== def.id && !chain.includes(s.id)).map(consultTool) : [];
  return { own, all: [...own, ...peers, shareTool()] };
}

async function systemFor(def: AgentDef, ctx: ToolContext, own: Tool[]) {
  const settings = await getSettings();
  const missing = [...new Set(def.tools.filter((t) => t.integration && !own.includes(t)).map((t) => t.integration!))];
  return (
    specialistSystemPrompt(def, { timezone: ctx.timezone, user: ctx.user, settings }) +
    (missing.length ? `\n\n(Integrações não conectadas para você: ${missing.join(", ")})` : "")
  );
}

/** ask_<especialista>: conversa contínua do CTO com um especialista durante a execução. */
export function delegationTool(def: AgentDef): Tool<{ message: string }> {
  return defineTool({
    name: `ask_${def.id}`,
    description:
      `${def.emoji} ${def.name}: ${def.role} ` +
      "É uma conversa: chamar de novo continua de onde parou (use para cobrar, corrigir ou pedir mais). Mande a tarefa completa na primeira vez.",
    parameters: obj({ message: { type: "string", description: "Tarefa ou resposta para o especialista, com todo o contexto necessário" } }, ["message"]),
    async run(args, ctx) {
      return ctx.room.withLock(def.id, async () => {
        const chain = [...ctx.callChain, def.id];
        const { own, all } = await toolsFor(def, chain);
        const thread = ctx.room.threads.get(def.id) ?? [{ role: "system", content: await systemFor(def, ctx, own) } as ChatMessage];
        thread.push({ role: "user", content: `[CTO] ${args.message}${ctx.room.boardText()}` });
        ctx.room.edges.push({ from: ctx.agent, to: def.id });
        const r = await runToolLoop({ agent: def.id, task: `agent:${def.id}`, ctx: { ...ctx, agent: def.id, callChain: chain }, tools: all, maxSteps: 7, messages: thread });
        ctx.room.threads.set(def.id, r.messages);
        return { report: r.text || "(o especialista não retornou relatório)" };
      });
    },
  });
}

/** consult_<colega>: um especialista pergunta algo direto para outro, sem passar pelo CTO. */
export function consultTool(def: AgentDef): Tool<{ question: string }> {
  return defineTool({
    name: `consult_${def.id}`,
    description: `Pergunte ao colega ${def.emoji} ${def.name} (${def.role}) algo da área dele. Seja específico e dê o contexto.`,
    parameters: obj({ question: { type: "string" } }, ["question"]),
    async run(args, ctx) {
      const chain = [...ctx.callChain, def.id];
      if (ctx.callChain.includes(def.id) || chain.length > MAX_CHAIN) {
        return { error: `Não dá para consultar ${def.name} agora (já está nesta cadeia de conversa). Resolva com o que tem ou devolva ao CTO.` };
      }
      const { own, all } = await toolsFor(def, chain);
      ctx.room.edges.push({ from: ctx.agent, to: def.id });
      // Consulta entre colegas usa uma conversa própria (não trava a conversa do CTO com o mesmo agente)
      const r = await runToolLoop({
        agent: def.id,
        task: `agent:${def.id}`,
        ctx: { ...ctx, agent: def.id, callChain: chain },
        tools: all,
        maxSteps: 5,
        messages: [
          { role: "system", content: await systemFor(def, ctx, own) },
          { role: "user", content: `[${NAMES[ctx.agent] ?? ctx.agent}, seu colega de time, pergunta] ${args.question}${ctx.room.boardText()}` },
        ],
      });
      return { answer: r.text || "(sem resposta)" };
    },
  });
}
