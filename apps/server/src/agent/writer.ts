import { chatCompletion } from "../llm/openrouter.js";
import { resolveModel } from "../llm/router.js";
import type { ToolContext } from "./tools/types.js";

/**
 * Texto longo (PDF, áudio, página do Notion) escrito numa chamada própria, com saída folgada (rota "writer").
 * Os agentes têm teto de 1000 a 1500 tokens por resposta: um documento inteiro não cabe nos argumentos da
 * ferramenta, e o modelo acabava mandando só o título e repetindo a chamada. Com isso o agente manda o pedido
 * (brief) e a ferramenta escreve.
 */
export async function writeLong(ctx: ToolContext, opts: { name: string; system: string; ask: string; json?: boolean; maxTokens?: number }): Promise<string> {
  const step = await ctx.tracer.step({ agent: "redator", type: "llm", name: opts.name, parentId: ctx.parentStepId, input: { ask: opts.ask } });
  try {
    const r = await chatCompletion(await resolveModel("writer"), {
      ...(opts.json ? { responseFormat: { type: "json_object" } } : {}),
      ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.ask.slice(0, 6000) },
      ],
    });
    const text = String(r.message.content ?? "").trim();
    await step.ok({ chars: text.length }, { model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd });
    return text;
  } catch (err) {
    await step.fail(err);
    throw err;
  }
}

/** JSON de dentro da resposta (tira cercas de código e texto em volta). */
export function parseJsonObject(text: string): unknown {
  const raw = text.replace(/^```(json)?|```$/g, "").trim();
  return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
}
