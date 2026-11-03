import type { ChatMessage } from "../llm/types.js";
import { one, query } from "../db/pool.js";
import type { BrowserSession } from "./browser.js";
import { getSettings } from "../settings.js";
import { specialistSystemPrompt } from "./prompts.js";
import { promptOverrides } from "./prompt-overrides.js";
import { availableTools, isOwnerOnly, runToolLoop } from "./runner.js";
import { isOwner } from "../ingest.js";
import { noteTeamTalk } from "../channels/app.js";
import { SPECIALISTS, type AgentDef } from "./team.js";
import { defineTool, obj, type Tool, type ToolContext } from "./tools/types.js";
import { notebookNotes } from "./tools/notebook.js";

/** Profundidade máxima de conversa: CTO -> especialista -> colega. */
const MAX_CHAIN = 3;
/** Quanto antes do prazo da execução o especialista para, para o CTO ler e responder (modelo lento leva ~1 min por passo). */
const ASK_RESERVE_MS = 90_000;
/** Mesma folga para quem consultou um colega. */
const CONSULT_RESERVE_MS = 45_000;
/**
 * Tempo máximo de cada pedido a um especialista (antes era só "90 s antes do fim da execução", e uma pesquisa
 * chegou a levar 4 min). Pesquisa responde com o que achou nesse tempo.
 */
export const ASK_BUDGET_MS: Record<string, number> = { pesquisador: 80_000, default: 120_000 };
export const CONSULT_BUDGET_MS = 45_000;
/** Pedidos ao mesmo especialista numa resposta: depois disso o CTO responde com o que tem (a pesquisa do carro foi pedida 3 vezes). */
export const MAX_ASKS_PER_AGENT = 2;

/**
 * O especialista parou sem escrever o relatório (tempo ou passos acabaram): devolve o que as ferramentas
 * dele já trouxeram, encurtado, para o CTO responder com isso em vez de "não deu".
 */
export function partialReport(messages: ChatMessage[], timedOut?: boolean) {
  const found = messages
    .filter((m) => m.role === "tool" && typeof m.content === "string" && !/^\{"error"/.test(m.content))
    .slice(-4)
    .map((m) => String(m.content).slice(0, 700));
  const why = timedOut ? "Parei por falta de tempo" : "Parei sem fechar o relatório";
  return found.length
    ? `${why}. O que já levantei (dados brutos das ferramentas, confira antes de usar):\n${found.join("\n---\n")}`
    : `${why} e não consegui levantar nada útil.`;
}

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
  /** quanto do navegador esta execução já usou (cada abertura e clique custa segundos e memória da máquina) */
  usage = { browserOpens: 0, browserActions: 0, mapPrints: 0 };
  /** por que esta execução respondeu pela metade (vira "Parcial" em Execuções) */
  partial?: string;
  /** resumos (do servidor) das ações que ficaram esperando o "sim" nesta execução */
  confirmations: string[] = [];
  /** ferramentas que guardaram um pedido novo de "sim" nesta execução (uma ação por vez) */
  askedTools = new Set<string>();
  /** pedido de uma rodada anterior que continua esperando o sim (a pessoa respondeu sem texto ou com "sim, mas...") */
  keptTool?: string;
  /** quantas vezes o CTO já chamou cada especialista nesta execução */
  asks = new Map<string, number>();
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

/** Ferramentas que abrem um Chrome de verdade: lentas (segundos por clique) e pesadas na máquina. */
const CHROME_TOOL = /^(browser_|screenshot_url$)/;
/** A pessoa (ou o CTO no pedido) quer ver a página: print, gravação, tela, entrar, navegar ou preencher formulário no site. */
const WANTS_SCREEN = /\b(print|printa|captura de tela|screenshot|grav(a|e|ar|ação|acao|ando)|v[ií]deo da (tela|navega)|mostr\w* (a )?tela|entr\w* no site|abr\w* o site|naveg\w*|preench\w* (o |um |esse |este )?(formul[aá]rio|cadastro|site|campo)|formul[aá]rio (do|no|de) site)/i;

/**
 * Pesquisa é texto: busca e leitura de página resolvem sem navegador. O Chrome (browser_*, screenshot_url) só entra
 * quando alguém pediu para ver ou gravar.
 */
export function needsChrome(_def: { id: string }, ...texts: (string | undefined)[]) {
  return texts.some((t) => t && WANTS_SCREEN.test(t));
}

/**
 * Colegas que um agente sob medida pode consultar: só os que não mandam mensagem a terceiros nem mexem no dinheiro,
 * para a lista CLIENT_AGENT_TOOLS valer também por tabela (antes ele pedia ao Moacir para apagar um lançamento).
 */
export const CLIENT_AGENT_PEERS = new Set(["pesquisador", "agenda"]);

/** Separa as ferramentas do agente entre as que vão na lista (núcleo + assunto do pedido) e as que ficam escondidas. */
export function byTopic(def: Pick<AgentDef, "toolGroups">, tools: Tool[], text: string) {
  if (!def.toolGroups?.length) return { shown: tools, hidden: [] as Tool[] };
  const gated = new Set(def.toolGroups.flatMap((g) => g.tools.map((t) => t.name)));
  const wanted = new Set(def.toolGroups.filter((g) => g.when.test(text)).flatMap((g) => g.tools.map((t) => t.name)));
  const hidden = tools.filter((t) => gated.has(t.name) && !wanted.has(t.name));
  return { shown: tools.filter((t) => !hidden.includes(t)), hidden };
}

async function toolsFor(def: AgentDef, chain: string[], ctx: ToolContext, request?: string) {
  let own = await availableTools(def.tools, ctx.user);
  if (!needsChrome(def, ctx.inboundText, ctx.typedText, request)) own = own.filter((t) => !CHROME_TOOL.test(t.name));
  // ferramentas por assunto (Financeiro: cartões, contas fixas, metas...): só vão na lista paga quando o pedido fala disso;
  // fora dela continuam rodando se chamadas pelo nome
  const split = byTopic(def, own, [request, ctx.inboundText, ctx.typedText].filter(Boolean).join("\n"));
  own = split.shown;
  const hidden = split.hidden;
  // colegas consultáveis: só os fixos. Agente sob medida é de um assunto da pessoa e o CTO chama direto
  const peers =
    chain.length < MAX_CHAIN
      ? ctx.room.team.filter((s) => !s.clientAgentId && s.id !== def.id && !chain.includes(s.id) && (!def.clientAgentId || CLIENT_AGENT_PEERS.has(s.id)))
      : [];
  return { own, hidden, all: [...own, ...(peers.length ? [consultTool(peers)] : []), shareTool()] };
}

/**
 * Caderno do agente sob medida no prompt: as notas mais recentes já vão junto (poupa um passo de leitura),
 * mais a regra de que "registrado" só vale depois do notebook_save.
 */
async function notebookText(userId: string, clientAgentId: string) {
  const notes = await notebookNotes(userId, clientAgentId, { limit: 15 });
  const list = notes.length
    ? `\nÚltimas notas (mais novas primeiro):\n${notes.map((n) => `- ${n.day ?? "?"}: ${n.note.slice(0, 300)}`).join("\n")}`
    : "\nCaderno vazio por enquanto.";
  return (
    "\n\n# Seu caderno\nÉ o único lugar seu que dura entre uma conversa e outra; o quadro do time some no fim da tarefa. " +
    "O que ela pedir para registrar (presença, valores, pagamentos, combinados): notebook_save antes de dizer que registrou. " +
    "Para o resumo de um período, notebook_read com from/to." +
    list
  );
}

/** "Pedido dela: ... Aprendido nas reuniões: ..." (o que existir), para prompt e listas. */
export function noteText(n?: { note?: string | null; user_note?: string | null } | null) {
  if (!n) return null;
  const parts = [n.user_note ? `Pedido dela: ${n.user_note}` : "", n.note ? `Aprendido nas reuniões: ${n.note}` : ""].filter(Boolean);
  return parts.length ? parts.join(". ") : null;
}

async function systemFor(def: AgentDef, ctx: ToolContext, own: Tool[]) {
  const settings = await getSettings();
  const owner = isOwner(ctx.user.phone);
  const missing = [
    ...new Set(def.tools.filter((t) => t.integration && !own.includes(t) && !CHROME_TOOL.test(t.name) && (owner || !isOwnerOnly(t))).map((t) => t.integration!)),
  ];
  return (
    specialistSystemPrompt(def, {
      timezone: ctx.timezone,
      user: ctx.user,
      settings,
      teamRules: (await promptOverrides()).get("_time")?.instructions,
      note: noteText(await one("SELECT note, user_note FROM agent_notes WHERE user_id = $1 AND agent = $2", [ctx.user.id, def.id]).catch(() => null)),
    }) +
    (missing.length ? `\n\n(Integrações não conectadas para você: ${missing.join(", ")})` : "") +
    (def.clientAgentId ? await notebookText(ctx.user.id, def.clientAgentId).catch(() => "") : "")
  );
}

/** ask_<especialista>: conversa contínua do CTO com um especialista durante a execução. */
export function delegationTool(def: AgentDef): Tool<{ message: string }> {
  return defineTool({
    name: `ask_${def.id}`,
    description:
      `${def.name}: ${def.role} Chamar de novo continua a conversa.`,
    parameters: obj({ message: { type: "string", description: "Tarefa completa, com o contexto" } }, ["message"]),
    async run(args, ctx) {
      const asked = (ctx.room.asks.get(def.id) ?? 0) + 1;
      if (asked > MAX_ASKS_PER_AGENT) {
        return { error: `Você já pediu ${MAX_ASKS_PER_AGENT} vezes para ${def.persona ?? def.name} nesta resposta. Responda à pessoa agora com o que voltou (dados e links), dizendo o que não deu para confirmar.` };
      }
      ctx.room.asks.set(def.id, asked);
      return ctx.room.withLock(def.id, async () => {
        const chain = [...ctx.callChain, def.id];
        const { own, hidden, all } = await toolsFor(def, chain, ctx, args.message);
        const known = ctx.room.threads.get(def.id);
        const thread = known ?? [{ role: "system", content: await systemFor(def, ctx, [...own, ...hidden]) } as ChatMessage];
        // chegou foto/documento nesta rodada: o especialista vê a mensagem já interpretada, não só o resumo do CTO
        const withMedia = Boolean(ctx.inboundImages?.length || ctx.inboundFiles?.length);
        const original = !known && withMedia && ctx.inboundText ? `\n\n[Mensagem da pessoa, com a mídia já descrita]\n${ctx.inboundText}` : "";
        thread.push({ role: "user", content: `[CTO] ${args.message}${original}${ctx.room.boardText()}` });
        ctx.room.edges.push({ from: ctx.agent, to: def.id });
        await noteTeamTalk(ctx, ctx.agent, def.id, args.message, "ask");
        if (def.clientAgentId) void query("UPDATE client_agents SET uses = uses + 1 WHERE id = $1", [def.clientAgentId]).catch(() => {});
        // prazo próprio: o especialista para antes e o CTO ainda tem tempo de responder com o que voltou
        const guard = ctx.guard?.sub(ASK_RESERVE_MS, ASK_BUDGET_MS[def.id] ?? ASK_BUDGET_MS.default);
        try {
          const r = await runToolLoop({ agent: def.id, task: def.task ?? `agent:${def.id}`, ctx: { ...ctx, guard, agent: def.id, callChain: chain }, tools: all, hiddenTools: hidden, maxSteps: 7, messages: thread });
          ctx.room.threads.set(def.id, r.messages);
          if (r.timedOut) ctx.room.partial ??= `${def.persona ?? def.name} parou no prazo dele e devolveu o que tinha`;
          const report = r.text || partialReport(r.messages, r.timedOut);
          if (r.text) await noteTeamTalk(ctx, def.id, ctx.agent, r.text, "reply");
          // relatório pela metade: pedir de novo costuma dar no mesmo e dobra a espera da pessoa
          return r.text ? { report } : { report, next: "Responda à pessoa com o que veio aqui (links e dados) e diga o que faltou; não peça de novo." };
        } finally {
          guard?.dispose();
        }
      });
    },
  });
}

/** Começo do papel (até 90 caracteres), para a lista de colegas da consult_colega caber em poucas linhas. */
function shortRole(role: string) {
  const first = (role.split(/(?<=[.!?:])\s/)[0] ?? role).replace(/[.:]$/, "");
  return first.length > 90 ? `${first.slice(0, 87)}…` : first;
}

/**
 * consult_colega: um especialista pergunta algo direto para outro, sem passar pelo CTO. Uma ferramenta só, com o
 * colega como argumento: antes eram 7 consult_<colega> pagas em todo passo de cada especialista (~2,9 mil caracteres).
 * O passo aparece em Execuções como consult_<colega>, igual antes.
 */
export function consultTool(peers: AgentDef[]): Tool<{ colega: string; question: string }> {
  return defineTool({
    name: "consult_colega",
    description: `Pergunte a um colega do time algo da área dele, com contexto. Chamar de novo continua a conversa. Colegas: ${peers.map((p) => `${p.id} (${shortRole(p.role)})`).join("; ")}.`,
    parameters: obj({ colega: { type: "string", enum: peers.map((p) => p.id) }, question: { type: "string" } }, ["colega", "question"]),
    async run(args, ctx) {
      const def = peers.find((p) => p.id === args.colega);
      if (!def) return { error: `Colega desconhecido: ${args.colega}. Use um de: ${peers.map((p) => p.id).join(", ")}.` };
      const chain = [...ctx.callChain, def.id];
      if (ctx.callChain.includes(def.id) || chain.length > MAX_CHAIN) {
        return { error: `Não dá para consultar ${def.name} agora (já está nesta cadeia de conversa). Resolva com o que tem ou devolva ao CTO.` };
      }
      // Consulta entre colegas usa uma conversa própria (não trava a conversa do CTO com o mesmo agente).
      // A mesma dupla volta a conversar de onde parou: o prompt do colega não é montado e pago de novo a cada pergunta.
      const key = `consult:${ctx.agent}>${def.id}`;
      return ctx.room.withLock(key, async () => {
        const { own, hidden, all } = await toolsFor(def, chain, ctx, args.question);
        ctx.room.edges.push({ from: ctx.agent, to: def.id });
        await noteTeamTalk(ctx, ctx.agent, def.id, args.question, "ask");
        if (def.clientAgentId) void query("UPDATE client_agents SET uses = uses + 1 WHERE id = $1", [def.clientAgentId]).catch(() => {});
        const thread = ctx.room.threads.get(key) ?? [{ role: "system", content: await systemFor(def, ctx, [...own, ...hidden]) } as ChatMessage];
        thread.push({ role: "user", content: `[${ctx.room.nameOf(ctx.agent)}, seu colega de time, pergunta] ${args.question}${ctx.room.boardText()}` });
        const guard = ctx.guard?.sub(CONSULT_RESERVE_MS, CONSULT_BUDGET_MS);
        try {
          const r = await runToolLoop({
            agent: def.id,
            task: def.task ?? `agent:${def.id}`,
            ctx: { ...ctx, guard, agent: def.id, callChain: chain },
            tools: all,
            hiddenTools: hidden,
            maxSteps: 5,
            messages: thread,
          });
          ctx.room.threads.set(key, r.messages);
          if (r.text) await noteTeamTalk(ctx, def.id, ctx.agent, r.text, "reply");
          return { answer: r.text || partialReport(r.messages, r.timedOut) };
        } finally {
          guard?.dispose();
        }
      });
    },
  });
}
