export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  /** plugins do OpenRouter, ex.: [{ id: "web" }] para busca na web */
  plugins?: Record<string, unknown>[];
  responseFormat?: Record<string, unknown>;
  /** saídas pedidas ao modelo, ex.: ["image", "text"] para gerar imagem (rota "image") */
  modalities?: string[];
  /** ajuste da imagem gerada, ex.: { aspect_ratio: "16:9" } (o modelo que não entende ignora) */
  imageConfig?: Record<string, unknown>;
  /** "off": sem raciocínio (texto longo do redator; o raciocínio comia o teto de saída e o texto voltava vazio) */
  reasoning?: "off";
  /** cancela a chamada (prazo máximo da execução) */
  signal?: AbortSignal;
  /** interno do chatCompletion: repetição sem a trava de coleta de dados */
  allowDataCollection?: boolean;
}

export interface ChatResult {
  message: { content: string | null; tool_calls?: ToolCall[]; images?: string[] };
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  finishReason?: string;
}
