import { chatCompletion } from "../llm/openrouter.js";
import { resolveModel } from "../llm/router.js";
import type { ChatMessage, ToolSpec } from "../llm/types.js";
import { isConnected } from "../integrations/registry.js";
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

  for (let step = 1; step <= maxSteps; step++) {
    const last = step === maxSteps;
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
      res = await chatCompletion(choice, { messages, tools: last ? undefined : specs });
    } catch (err) {
      await llmStep.fail(err);
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
        if (!tool) {
          await toolStep.fail(`Tool desconhecida: ${call.function.name}`);
          return { id: call.id, content: JSON.stringify({ error: `Tool desconhecida: ${call.function.name}` }) };
        }
        try {
          const out: any = await tool.run(args, { ...ctx, parentStepId: toolStep.id });
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
          return { id: call.id, content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) };
        }
      }),
    );
    for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.content.slice(0, 30_000) });
  }
  return { text: "", steps: maxSteps, messages };
}
