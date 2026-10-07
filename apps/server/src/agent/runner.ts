import { chatCompletion } from "../llm/openrouter.js";
import { resolveModel } from "../llm/router.js";
import type { ChatMessage, ToolSpec } from "../llm/types.js";
import { isConnected } from "../integrations/registry.js";
import { cacheGet, cacheSet } from "../shortmem.js";
import { toolCacheKey } from "./cache.js";
import type { Tool, ToolContext } from "./tools/types.js";

export async function availableTools(tools: Tool[]) {
  const out: Tool[] = [];
  for (const t of tools) if (!t.integration || (await isConnected(t.integration))) out.push(t);
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
  }
  return { text: "", steps: maxSteps, messages };
}
