import { chatCompletion } from "../llm/openrouter.js";
import { resolveModel } from "../llm/router.js";
import type { ChatMessage, ToolSpec } from "../llm/types.js";
import { isConnected } from "../integrations/registry.js";
import { isOwner } from "../ingest.js";
import { cacheGet, cacheSet } from "../shortmem.js";
import { toolCacheKey } from "./cache.js";
import type { Tool, ToolContext } from "./tools/types.js";

/** Ferramentas que não mudam a resposta: se o CTO já escreveu o texto junto, não precisa de outra rodada. */
const QUICK_TOOLS = new Set(["react_to_message", "save_memory"]);
/** Chamadas demoradas: delegação ao time e navegador. Ligam os avisos de andamento. */
const SLOW_TOOL = /^(ask_|browser_|screenshot_url)/;

/**
 * Integrações que são contas pessoais do dono da stack (o e-mail, a agenda, o Notion, o caixa dele).
 * As credenciais são uma só para a plataforma inteira, então só o dono pode usar essas ferramentas:
 * um convidado pedindo "lê meus e-mails" não pode cair no Gmail do dono.
 */
export const OWNER_INTEGRATIONS = new Set(["google", "slack", "notion", "github", "linear", "n8n", "mercadopago", "stripe"]);

export function isOwnerOnly(t: Pick<Tool, "integration" | "ownerOnly">) {
  // ownerOnly: false libera de propósito uma ferramenta de integração do dono (ex.: automações seguras dos clientes)
  return t.ownerOnly ?? Boolean(t.integration && OWNER_INTEGRATIONS.has(t.integration));
}

/** Ferramentas que esta pessoa pode usar agora: integração conectada e, se for do dono, só para o dono. */
export async function availableTools(tools: Tool[], user?: { phone: string } | null) {
  const owner = user ? isOwner(user.phone) : false;
  const out: Tool[] = [];
  for (const t of tools) {
    if (isOwnerOnly(t) && !owner) continue;
    if (!t.integration || (await isConnected(t.integration))) out.push(t);
  }
  return out;
}

export function toSpecs(tools: Tool[]): ToolSpec[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export interface LoopResult {
  text: string;
  steps: number;
  /** parou porque estourou o tempo máximo */
  timedOut?: boolean;
  /** conversa completa (com tool calls), para continuar depois */
  messages: ChatMessage[];
}

/**
 * Loop de tool-calling: chama o modelo da rota `task`, executa as tools pedidas (em paralelo),
 * devolve os resultados e repete até o modelo responder só com texto.
 */
export async function runToolLoop(opts: {
  agent: string;
  task: string;
  messages: ChatMessage[];
  tools: Tool[];
  ctx: ToolContext;
  maxSteps?: number;
}): Promise<LoopResult> {
  const { ctx, agent } = opts;
  const messages = [...opts.messages];
  const specs = toSpecs(opts.tools);
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const choice = await resolveModel(opts.task);
  const maxSteps = opts.maxSteps ?? 8;

  const guard = ctx.guard;
  let warned = false;

  for (let step = 1; step <= maxSteps; step++) {
    if (guard?.expired) return { text: "", steps: step - 1, messages, timedOut: true };
    // perto do prazo (ou do limite de ações): sem ferramentas, responde com o que já tem
    const wrapUp = Boolean(guard?.wrapUp);
    const last = step === maxSteps || wrapUp;
    if (wrapUp && !warned) {
      warned = true;
      messages.push({
        role: "system",
        content:
          guard!.toolCalls >= guard!.maxToolCalls
            ? "Limite de ações desta tarefa atingido. Responda agora com o que já tem, dizendo o que ficou faltando."
            : "O tempo desta tarefa está acabando. Responda agora com o que já tem, dizendo o que ficou faltando.",
      });
    }
    const llmStep = await ctx.tracer.step({
      agent,
      type: "llm",
      name: `${agent} · passo ${step}`,
      model: choice.model,
      parentId: ctx.parentStepId,
      input: { messages: messages.slice(-6), tools: specs.map((s) => s.function.name) },
    });
    compactOldToolResults(messages);
    let res;
    try {
      res = await chatCompletion(choice, { messages, tools: last ? undefined : specs, signal: guard?.signal });
    } catch (err) {
      await llmStep.fail(guard?.expired ? guard.signal.reason : err);
      if (guard?.expired) return { text: "", steps: step, messages, timedOut: true };
      throw err;
    }
    await llmStep.ok(res.message, { model: res.model, tokensIn: res.tokensIn, tokensOut: res.tokensOut, costUsd: res.costUsd });

    const calls = res.message.tool_calls ?? [];
    if (!calls.length) {
      const text = (res.message.content ?? "").trim();
      messages.push({ role: "assistant", content: text });
      return { text, steps: step, messages };
    }

    // Ritmo da conversa (só o CTO fala com a pessoa)
    const said = (res.message.content ?? "").trim();
    const names = calls.map((c) => c.function.name);
    const slow = names.some((n) => SLOW_TOOL.test(n));
    if (ctx.progress && agent === "cto") {
      if (slow) {
        ctx.progress.busy();
        // a frase que o CTO escreveu junto da delegação ("já vou ver!") sai na hora
        if (said) await ctx.progress.say(said);
      }
    }
    // Só reagiu/anotou na memória e já escreveu a resposta: entrega sem gastar outra rodada do modelo
    const quickOnly = agent === "cto" && said && names.every((n) => QUICK_TOOLS.has(n));

    messages.push({ role: "assistant", content: res.message.content ?? null, tool_calls: calls });
    const results = await Promise.all(
      calls.map(async (call) => {
        const tool = byName.get(call.function.name);
        let args: any = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          return { id: call.id, content: JSON.stringify({ error: "Argumentos JSON inválidos" }) };
        }
        const isDelegate = call.function.name.startsWith("ask_") || call.function.name.startsWith("consult_");
        const toolStep = await ctx.tracer.step({
          agent,
          type: isDelegate ? "delegate" : "tool",
          name: call.function.name,
          input: args,
          parentId: ctx.parentStepId,
        });
        if (guard && guard.toolCalls >= guard.maxToolCalls) {
          await toolStep.fail("Limite de ações por resposta atingido");
          return { id: call.id, content: JSON.stringify({ error: "Limite de ações desta tarefa atingido. Finalize com o que já tem." }) };
        }
        if (guard) guard.toolCalls++;
        if (!tool) {
          await toolStep.fail(`Tool desconhecida: ${call.function.name}`);
          return { id: call.id, content: JSON.stringify({ error: `Tool desconhecida: ${call.function.name}` }) };
        }
        // segunda trava: mesmo que a ferramenta tenha escapado da lista, conta do dono só roda para o dono
        if (isOwnerOnly(tool) && !isOwner(ctx.user.phone)) {
          await toolStep.fail("Ferramenta só do dono da plataforma");
          return { id: call.id, content: JSON.stringify({ error: "Essa integração é só do dono da plataforma; não está disponível para esta pessoa." }) };
        }
        try {
          const ck = toolCacheKey(tool.name, args);
          const hit = ck ? await cacheGet<any>(ck.key) : null;
          if (hit != null) {
            await toolStep.ok({ cache: true, ...((typeof hit === "object" && hit) || { value: hit }) });
            return { id: call.id, content: typeof hit === "string" ? hit : JSON.stringify(hit) };
          }
          const run = tool.run(args, { ...ctx, parentStepId: toolStep.id });
          const out: any = guard ? await guard.race(run) : await run;
          if (ck && out != null && !(typeof out === "object" && ("error" in out || "media_id" in out))) {
            const { _usage, ...rest } = typeof out === "object" ? out : ({ value: out } as any);
            await cacheSet(ck.key, rest, ck.ttl);
          }
          let usage;
          if (out && typeof out === "object" && "_usage" in out) {
            const u = out._usage;
            usage = { model: u.model, tokensIn: u.tokensIn, tokensOut: u.tokensOut, costUsd: u.costUsd };
            delete out._usage;
          }
          await toolStep.ok(out, usage);
          return { id: call.id, content: typeof out === "string" ? out : JSON.stringify(out ?? { ok: true }) };
        } catch (err) {
          await toolStep.fail(err);
          if (guard?.expired) return { id: call.id, content: JSON.stringify({ error: "Tempo máximo da tarefa esgotado." }) };
          return { id: call.id, content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) };
        }
      }),
    );
    for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.content.slice(0, 12_000) });
    if (guard?.expired) return { text: "", steps: step, messages, timedOut: true };
    if (quickOnly && results.every((r) => !r.content.includes('"error"'))) {
      messages.push({ role: "assistant", content: said });
      return { text: said, steps: step, messages };
    }
  }
  return { text: "", steps: maxSteps, messages };
}

/** Resultado de ferramenta que o modelo já leu numa rodada anterior volta encurtado. */
const OLD_TOOL_CHARS = 3000;

/**
 * Cada passo do loop reenvia a conversa inteira; páginas e buscas lidas antes (até 12 mil caracteres cada)
 * eram pagas de novo a cada passo. Só o lote mais recente de resultados vai inteiro; os anteriores, que o
 * modelo já leu, seguem com o começo (onde ficam resposta, títulos e preços) até OLD_TOOL_CHARS.
 */
export function compactOldToolResults(messages: ChatMessage[]) {
  let i = messages.length - 1;
  while (i >= 0 && messages[i]!.role === "tool") i--; // lote atual fica inteiro
  for (; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "tool" && typeof m.content === "string" && m.content.length > OLD_TOOL_CHARS + 40) {
      messages[i] = { ...m, content: `${m.content.slice(0, OLD_TOOL_CHARS)}… [encurtado: já lido antes]` };
    }
  }
}
