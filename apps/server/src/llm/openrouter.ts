import { config } from "../config.js";
import type { ChatRequest, ChatResult } from "./types.js";

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface ModelChoice {
  model: string;
  fallbacks?: string[];
  temperature?: number | null;
  maxTokens?: number | null;
}

/** Chamada de chat completions no OpenRouter, com fallback de modelos e custo real retornado em usage.cost. */
export async function chatCompletion(choice: ModelChoice, req: ChatRequest, attempt = 0): Promise<ChatResult> {
  if (!config.OPENROUTER_API_KEY) throw new LlmError("OPENROUTER_API_KEY não configurada");
  const body: Record<string, unknown> = {
    model: choice.model,
    messages: req.messages,
    usage: { include: true },
  };
  if (choice.fallbacks?.length) body.models = [choice.model, ...choice.fallbacks];
  if (req.tools?.length) {
    body.tools = req.tools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }
  // raciocínio longo é saída cara: baixo em toda chamada, inclusive no último passo (sem ferramentas)
  if (req.modalities) body.modalities = req.modalities;
  else body.reasoning = { effort: "low", exclude: true };
  const temperature = req.temperature ?? choice.temperature;
  if (temperature != null) body.temperature = temperature;
  const maxTokens = req.maxTokens ?? choice.maxTokens;
  if (maxTokens != null) body.max_tokens = maxTokens;
  if (req.plugins) body.plugins = req.plugins;
  if (req.responseFormat) body.response_format = req.responseFormat;

  const res = await fetch(`${config.OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": config.PUBLIC_URL,
      "X-Title": "Planejai",
    },
    body: JSON.stringify(body),
    signal: req.signal ? AbortSignal.any([AbortSignal.timeout(120_000), req.signal]) : AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const text = await res.text();
    // 429/5xx: tenta de novo com backoff curto
    if ((res.status === 429 || res.status >= 500) && attempt < 2 && !req.signal?.aborted) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return chatCompletion(choice, req, attempt + 1);
    }
    throw new LlmError(`OpenRouter ${res.status}: ${text.slice(0, 500)}`, res.status);
  }

  const json: any = await res.json();
  if (json.error) throw new LlmError(`OpenRouter: ${json.error.message ?? JSON.stringify(json.error)}`);
  const choice0 = json.choices?.[0];
  if (!choice0) throw new LlmError("OpenRouter retornou resposta sem choices");
  return {
    message: {
      content: choice0.message?.content ?? null,
      tool_calls: choice0.message?.tool_calls,
      ...(choice0.message?.images?.length ? { images: choice0.message.images.map((i: any) => String(i?.image_url?.url ?? "")).filter(Boolean) } : {}),
    },
    model: json.model ?? choice.model,
    tokensIn: json.usage?.prompt_tokens ?? 0,
    tokensOut: json.usage?.completion_tokens ?? 0,
    costUsd: Number(json.usage?.cost ?? 0),
    finishReason: choice0.finish_reason,
  };
}

export interface CatalogModel {
  id: string;
  name: string;
  promptPerM: number;
  completionPerM: number;
  context: number;
  inputModalities: string[];
  tools: boolean;
}

let catalogCache: { at: number; models: CatalogModel[] } | null = null;

/** Catálogo público de modelos do OpenRouter (preço por milhão de tokens), com cache de 1h. */
export async function listModels(): Promise<CatalogModel[]> {
  if (catalogCache && Date.now() - catalogCache.at < 3_600_000) return catalogCache.models;
  const res = await fetch(`${config.OPENROUTER_BASE_URL}/models`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new LlmError(`Falha ao listar modelos: ${res.status}`);
  const json: any = await res.json();
  const models: CatalogModel[] = (json.data ?? []).map((m: any) => ({
    id: m.id,
    name: m.name,
    promptPerM: Number(m.pricing?.prompt ?? 0) * 1e6,
    completionPerM: Number(m.pricing?.completion ?? 0) * 1e6,
    context: m.context_length ?? 0,
    inputModalities: m.architecture?.input_modalities ?? [],
    tools: (m.supported_parameters ?? []).includes("tools"),
  }));
  catalogCache = { at: Date.now(), models };
  return models;
}
