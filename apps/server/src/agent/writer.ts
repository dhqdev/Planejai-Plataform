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
  const route = await resolveModel("writer");
  const call = (choice: typeof route, maxTokens?: number) =>
    chatCompletion(choice, {
      ...(opts.json ? { responseFormat: { type: "json_object" } } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      reasoning: "off",
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.ask.slice(0, 6000) },
      ],
    });
  try {
    let r = await call(route, opts.maxTokens);
    let text = String(r.message.content ?? "").trim();
    let retried = false;
    // voltou vazio ou cortado logo no começo (pedido grande, teto estourado): tenta mais uma vez com o dobro
    // de teto e, se tiver, no modelo reserva, antes de dizer à pessoa que não deu
    if (text.length < 400 && (!text || r.finishReason === "length")) {
      const next = route.fallbacks?.length ? { ...route, model: route.fallbacks[0]!, fallbacks: [route.model, ...route.fallbacks.slice(1)] } : route;
      const tokens = Math.min(16_000, (opts.maxTokens ?? route.maxTokens ?? 8000) * 2);
      const first = { chars: text.length, finish: r.finishReason, model: r.model, tokensOut: r.tokensOut, costUsd: r.costUsd };
      r = await call(next, tokens);
      text = String(r.message.content ?? "").trim() || text;
      r = { ...r, tokensOut: r.tokensOut + first.tokensOut, costUsd: r.costUsd + first.costUsd };
      retried = true;
    }
    await step.ok(
      { chars: text.length, finish: r.finishReason, ...(retried ? { nova_tentativa: true } : {}) },
      { model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd },
    );
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
