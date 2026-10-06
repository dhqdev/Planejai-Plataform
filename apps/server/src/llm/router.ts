import { many, query } from "../db/pool.js";
import type { ModelChoice } from "./openrouter.js";

export interface RouteDefault extends ModelChoice {
  task: string;
  label: string;
  why: string;
}

/**
 * Roteamento de modelos por tarefa. Cada agente do time e cada tarefa utilitária
 * usa o modelo mais barato que dá conta do recado. Preços de referência (US$/1M tokens,
 * entrada/saída) do catálogo do OpenRouter em out/2026; o dashboard mostra os preços ao vivo
 * e permite trocar qualquer rota sem redeploy.
 *
 * - deepseek/deepseek-v4.1-flash  0,055 / 1,32  tool-calling bom e entrada baratíssima (históricos longos)
 * - xiaomi/mimo-v2.6-flash        0,14  / 0,28  texto+imagem+áudio, saída muito barata
 * - qwen/qwen3.8-omni-flash       0,15  / 0,47  omni (áudio/vídeo), bom para transcrição
 * - google/gemini-3.8-flash       0,75  / 3,75  fallback mais forte para raciocínio e multimodal
 */
export const ROUTE_DEFAULTS: RouteDefault[] = [
  {
    task: "agent:cto",
    label: "CTO (orquestrador)",
    why: "Conversa com a pessoa, decide e delega. Entrada grande (histórico), saída curta: DeepSeek Flash.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["google/gemini-3.8-flash"],
    temperature: 0.6,
  },
  {
    task: "agent:pesquisador",
    label: "Pesquisador",
    why: "Busca na web, lê páginas e tira prints. Muito texto de entrada: MiMo Flash.",
    model: "xiaomi/mimo-v2.6-flash",
    fallbacks: ["deepseek/deepseek-v4.1-flash"],
    temperature: 0.2,
  },
  {
    task: "agent:agenda",
    label: "Agenda",
    why: "Lembretes e calendário; precisa acertar datas e argumentos das tools.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["google/gemini-3.8-flash"],
    temperature: 0.1,
  },
  {
    task: "agent:financeiro",
    label: "Financeiro",
    why: "Lançamentos, resumos e links de pagamento; argumentos numéricos exatos.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["google/gemini-3.8-flash"],
    temperature: 0.1,
  },
  {
    task: "agent:comunicacao",
    label: "Comunicação",
    why: "E-mail e Slack: ler, resumir e redigir.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["xiaomi/mimo-v2.6-flash"],
    temperature: 0.4,
  },
  {
    task: "agent:produtividade",
    label: "Produtividade",
    why: "Notion, Linear e GitHub.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["xiaomi/mimo-v2.6-flash"],
    temperature: 0.2,
  },
  {
    task: "vision",
    label: "Visão (fotos recebidas)",
    why: "Descreve fotos/prints/comprovantes antes do CTO responder.",
    model: "xiaomi/mimo-v2.6-flash",
    fallbacks: ["qwen/qwen3.8-omni-flash", "google/gemini-3.8-flash"],
    temperature: 0,
  },
  {
    task: "transcription",
    label: "Transcrição (áudios)",
    why: "Transcreve áudios do WhatsApp com modelo omni barato.",
    model: "qwen/qwen3.8-omni-flash",
    fallbacks: ["google/gemini-3.8-flash"],
    temperature: 0,
  },
  {
    task: "summary",
    label: "Resumo de conversa",
    why: "Compacta conversas longas em memória; saída barata.",
    model: "xiaomi/mimo-v2.6-flash",
    fallbacks: ["deepseek/deepseek-v4.1-flash"],
    temperature: 0.2,
  },
  {
    task: "web_search",
    label: "Busca web (plugin OpenRouter)",
    why: "Usado quando não há Tavily/Brave configurado: plugin web do OpenRouter.",
    model: "xiaomi/mimo-v2.6-flash",
    fallbacks: ["deepseek/deepseek-v4.1-flash"],
    temperature: 0,
  },
];

let cache: { at: number; rows: Map<string, ModelChoice> } | null = null;

export async function resolveModel(task: string): Promise<ModelChoice> {
  if (!cache || Date.now() - cache.at > 10_000) {
    const rows = await many("SELECT task, model, fallbacks, temperature, max_tokens FROM model_routes");
    cache = {
      at: Date.now(),
      rows: new Map(
        rows.map((r) => [
          r.task,
          { model: r.model, fallbacks: r.fallbacks, temperature: r.temperature, maxTokens: r.max_tokens },
        ]),
      ),
    };
  }
  const override = cache.rows.get(task);
  if (override) return override;
  const def = ROUTE_DEFAULTS.find((d) => d.task === task) ?? ROUTE_DEFAULTS[0]!;
  return { model: def.model, fallbacks: def.fallbacks, temperature: def.temperature, maxTokens: def.maxTokens };
}

export async function listRoutes() {
  await resolveModel("agent:cto");
  return ROUTE_DEFAULTS.map((d) => {
    const o = cache!.rows.get(d.task);
    return {
      task: d.task,
      label: d.label,
      why: d.why,
      default: { model: d.model, fallbacks: d.fallbacks ?? [] },
      model: o?.model ?? d.model,
      fallbacks: o?.fallbacks ?? d.fallbacks ?? [],
      temperature: o?.temperature ?? d.temperature ?? null,
      maxTokens: o?.maxTokens ?? d.maxTokens ?? null,
      overridden: Boolean(o),
    };
  });
}

export async function saveRoute(task: string, r: { model: string; fallbacks?: string[]; temperature?: number | null; maxTokens?: number | null }) {
  await query(
    `INSERT INTO model_routes (task, model, fallbacks, temperature, max_tokens, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (task) DO UPDATE SET model = $2, fallbacks = $3, temperature = $4, max_tokens = $5, updated_at = now()`,
    [task, r.model, r.fallbacks ?? [], r.temperature ?? null, r.maxTokens ?? null],
  );
  cache = null;
}

export async function resetRoute(task: string) {
  await query("DELETE FROM model_routes WHERE task = $1", [task]);
  cache = null;
}
