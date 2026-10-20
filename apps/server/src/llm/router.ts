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
 * - openrouter/free                0     / 0     roteador dos grátis: só em rota publicData (blog), sempre com pago de reserva
 *
 * Toda chamada sem publicData leva provider.data_collection = "deny": dado de cliente não vai para provedor que treina.
 *
 * maxTokens limita a saída de cada chamada (respostas de WhatsApp são curtas) para o custo não escapar.
 */
export const ROUTE_DEFAULTS: RouteDefault[] = [
  {
    task: "agent:cto",
    label: "CTO (orquestrador)",
    why: "Conversa com a pessoa, decide e delega. Entrada grande (histórico), saída curta: DeepSeek Flash.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["google/gemini-3.8-flash"],
    temperature: 0.6,
    maxTokens: 1200,
  },
  {
    task: "agent:pesquisador",
    label: "Pesquisador",
    why: "Busca na web e lê páginas. DeepSeek Flash: ~6 s por passo contra ~20 s do MiMo Flash (medido em Execuções, out/2026), preço parecido.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["xiaomi/mimo-v2.6-flash"],
    temperature: 0.2,
    maxTokens: 1500,
  },
  {
    task: "agent:agenda",
    label: "Agenda",
    why: "Lembretes e calendário; precisa acertar datas e argumentos das tools.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["google/gemini-3.8-flash"],
    temperature: 0.1,
    maxTokens: 1000,
  },
  {
    task: "agent:financeiro",
    label: "Financeiro",
    why: "Lançamentos, resumos e links de pagamento; argumentos numéricos exatos.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["google/gemini-3.8-flash"],
    temperature: 0.1,
    maxTokens: 1200,
  },
  {
    task: "agent:comunicacao",
    label: "Comunicação",
    why: "E-mail e Slack: ler, resumir e redigir.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["xiaomi/mimo-v2.6-flash"],
    temperature: 0.4,
    maxTokens: 1500,
  },
  {
    task: "agent:produtividade",
    label: "Produtividade",
    why: "Notion, Linear e GitHub.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["xiaomi/mimo-v2.6-flash"],
    temperature: 0.2,
    maxTokens: 1200,
  },
  {
    task: "agent:recados",
    label: "Recados",
    why: "Fala com estabelecimentos pela pessoa: mensagens curtas e decisões simples (fechar, perguntar). Barato e bom de conversa.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["xiaomi/mimo-v2.6-flash"],
    temperature: 0.3,
    maxTokens: 800,
  },
  {
    task: "agent:compras",
    label: "Compras",
    why: "Busca nas lojas, compara e monta a lista com links: poucas chamadas e texto curto. O preço vem pronto da ferramenta, então um modelo barato serve.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["xiaomi/mimo-v2.6-flash"],
    temperature: 0.1,
    maxTokens: 1200,
  },
  {
    task: "errand_check",
    label: "Trava dos recados",
    why: "Confere cada mensagem antes de ir para um estabelecimento (ofensa, trote, assunto nada a ver). Entrada curta e JSON de uma linha: o mais barato.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["xiaomi/mimo-v2.6-flash"],
    temperature: 0,
    // o raciocínio do modelo conta no limite: com 150 a resposta chegava vazia
    maxTokens: 500,
  },
  {
    task: "vision",
    label: "Visão (fotos recebidas)",
    why: "Descreve fotos/prints/comprovantes antes do CTO responder.",
    model: "xiaomi/mimo-v2.6-flash",
    fallbacks: ["qwen/qwen3.8-omni-flash", "google/gemini-3.8-flash"],
    temperature: 0,
    maxTokens: 900,
  },
  {
    task: "transcription",
    label: "Transcrição (áudios)",
    why: "Transcreve áudios do WhatsApp com modelo omni barato.",
    model: "qwen/qwen3.8-omni-flash",
    fallbacks: ["google/gemini-3.8-flash"],
    temperature: 0,
    maxTokens: 1500,
  },
  {
    task: "tts",
    label: "Voz (áudios enviados)",
    why: "Mensagem de voz em pt-BR (história, resumo). Kokoro é a voz mais barata do OpenRouter: US$ 0,62 por milhão de caracteres (~US$ 0,0006 por minuto). Voz em TTS_VOICE.",
    model: "hexgrad/kokoro-82m",
    fallbacks: ["google/gemini-3.8-flash-lite-tts"],
  },
  {
    task: "tts_caprichado",
    label: "Voz caprichada (ocasiões especiais)",
    why: "Áudio especial (história, parabéns, homenagem, quando a pessoa pede voz mais bonita). ElevenLabs soa bem mais natural, mas custa ~65x o Kokoro (US$ 40 por milhão de caracteres, ~US$ 0,04 por minuto), por isso só em áudio curto (até TTS_CAPRICHADO_MAX_CHARS) e sem passar disso volta para a voz normal. Voz em TTS_VOICE_CAPRICHADA.",
    model: "elevenlabs/eleven-v4-turbo",
    fallbacks: ["elevenlabs/eleven-flash-v2.5", "hexgrad/kokoro-82m"],
  },
  {
    task: "writer",
    label: "Redator (PDF, áudio, Notion)",
    why: "Escreve o texto longo das ferramentas (PDF, mensagem de voz, página do Notion) a partir do pedido. Os agentes só mandam o que querem: o teto de saída deles não cabe um documento. Aqui a saída é longa, por isso o teto alto.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["google/gemini-3.8-flash"],
    temperature: 0.5,
    maxTokens: 8000,
  },
  {
    task: "blog",
    label: "Blog (post da semana)",
    why: "Escreve sozinho o post semanal do blog público (/blog): texto longo e organizado em seções, uma vez por semana. Também o post de novidades quando o sistema muda. As ilustrações saem da rota Blog (ilustrações). Texto público, sem dado de cliente: tenta primeiro o roteador grátis do OpenRouter (escolhe um modelo :free que aceite JSON) e cai no DeepSeek pago se o grátis estiver no limite; se o texto do grátis não servir, a segunda tentativa já vai no pago.",
    model: "openrouter/free",
    fallbacks: ["deepseek/deepseek-v4.1-flash", "google/gemini-3.8-flash"],
    publicData: true,
    temperature: 0.7,
    maxTokens: 9000,
  },
  {
    task: "blog:image",
    label: "Blog (ilustrações)",
    why: "Capa e ilustração do meio de cada post do blog, no nível de revista: Gemini 3 Pro Image (~US$ 0,14 por imagem, ~US$ 0,28 por post). Só o blog usa; o cliente continua na rota Imagens, barata.",
    model: "google/gemini-3-pro-image-preview",
    fallbacks: ["google/gemini-2.5-flash-image"],
    publicData: true,
  },
  {
    task: "image",
    label: "Imagens (gerar foto ou ilustração)",
    why: "Pediu uma foto, desenho ou ilustração: um modelo de imagem barato gera direto, sem navegador. Foto de coisa real (produto, lugar) primeiro é buscada na Tavily/Brave e só gera se não achar.",
    model: "google/gemini-2.5-flash-image",
  },
  {
    task: "summary",
    label: "Resumo de conversa",
    why: "Compacta conversas longas em memória; saída barata.",
    model: "xiaomi/mimo-v2.6-flash",
    fallbacks: ["deepseek/deepseek-v4.1-flash"],
    temperature: 0.2,
    maxTokens: 700,
  },
  {
    task: "agent:cliente",
    label: "Agentes de cada cliente",
    why: "Especialistas criados pela melhoria diária (ex.: Cinema, Celulares). Mesmo perfil do Pesquisador: DeepSeek Flash, que responde em ~6 s por passo (MiMo ~20 s).",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["xiaomi/mimo-v2.6-flash"],
    temperature: 0.2,
    maxTokens: 1200,
  },
  {
    task: "improve",
    label: "Melhoria diária (19h)",
    why: "Uma chamada por cliente ativo por dia: lê um resumo do uso, anota o que aprendeu sobre a pessoa, escreve a ata e decide se cria ou ajusta agentes. Saída JSON.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["google/gemini-3.8-flash"],
    temperature: 0.2,
    maxTokens: 1400,
  },
  {
    task: "proactive",
    label: "Avisos proativos",
    why: "Escreve o aviso quando um acompanhamento acha algo melhor. Poucas linhas, modelo mais barato.",
    model: "xiaomi/mimo-v2.6-flash",
    fallbacks: ["deepseek/deepseek-v4.1-flash"],
    temperature: 0.5,
    maxTokens: 220,
  },
  {
    task: "web_search",
    label: "Busca web (plugin OpenRouter)",
    why: "Usado quando não há Tavily/Brave configurado: plugin web do OpenRouter.",
    model: "xiaomi/mimo-v2.6-flash",
    fallbacks: ["deepseek/deepseek-v4.1-flash"],
    temperature: 0,
  },
  {
    task: "dev:refine",
    label: "Esteira: Lia (analista)",
    why: "Esteira de desenvolvimento (só o dono): reescreve o chamado com critérios de aceite e aponta os arquivos. Lê muito e escreve pouco: entrada barata do DeepSeek Flash.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["google/gemini-3.8-flash"],
    temperature: 0.2,
    maxTokens: 4000,
  },
  {
    task: "dev:vision",
    label: "Esteira: Lia olhando imagens",
    why: "Quando o chamado tem print ou foto, a Lia descreve cada imagem uma vez (textos, erros, o que está marcado) e o time inteiro lê só esse texto. Modelo de visão barato.",
    model: "xiaomi/mimo-v2.6-flash",
    fallbacks: ["google/gemini-3.8-flash"],
    temperature: 0,
    maxTokens: 1500,
  },
  {
    task: "dev:plan",
    label: "Esteira: Beto (arquiteto)",
    why: "Lê os arquivos que a Lia apontou, decide o passo a passo e responde as dúvidas do Caio. Muita entrada, pouca saída.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["google/gemini-3.8-flash"],
    temperature: 0.2,
    maxTokens: 4000,
  },
  {
    task: "dev:code",
    label: "Esteira: Caio (desenvolvedor)",
    why: "Escreve as trocas no código e conserta o CI vermelho. É onde a qualidade mais pesa: troque aqui por um modelo de código mais forte se os PRs vierem fracos (o custo aparece por etapa na tela Esteira).",
    model: "google/gemini-3.8-flash",
    fallbacks: ["deepseek/deepseek-v4.1-flash"],
    temperature: 0.1,
    maxTokens: 16000,
  },
  {
    task: "dev:code:simples",
    label: "Esteira: Caio em chamado simples",
    why: "Chamado simples (1 a 3 arquivos, mudança local): o Caio coda com o modelo barato. Se não sair, o chamado vira médio sozinho e passa pelo Beto e pela rota principal do Caio.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["google/gemini-3.8-flash"],
    temperature: 0.1,
    maxTokens: 8000,
  },
  {
    task: "dev:review",
    label: "Esteira: Vera (revisora)",
    why: "Lê o diff contra os critérios de aceite antes de abrir o PR e devolve uma vez para o desenvolvedor se achar problema real.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["google/gemini-3.8-flash"],
    temperature: 0,
    maxTokens: 2000,
  },
  {
    task: "dev:qa",
    label: "Esteira: Tito (testes)",
    why: "Quando o CI fica vermelho, lê o log e explica ao Caio o que quebrou em até 3 frases. O mais barato que lê log.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["xiaomi/mimo-v2.6-flash"],
    temperature: 0,
    maxTokens: 800,
  },
  {
    task: "dev:retro",
    label: "Esteira: retrospectiva do time",
    why: "Quando um chamado termina com atrito (revisão devolvida, troca que não aplicou, CI vermelho), transforma o que deu errado em até 3 lições curtas que entram no prompt do agente nos próximos chamados. Lê só fatos resumidos; chamado que saiu de primeira não chama modelo.",
    model: "deepseek/deepseek-v4.1-flash",
    fallbacks: ["xiaomi/mimo-v2.6-flash"],
    temperature: 0.2,
    maxTokens: 700,
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
  // publicData vem sempre do código (rota sem dado de cliente), nunca do que foi salvo na tela Modelos
  const def = ROUTE_DEFAULTS.find((d) => d.task === task) ?? ROUTE_DEFAULTS[0]!;
  const publicData = def.task === task && def.publicData === true ? { publicData: true } : {};
  const override = cache.rows.get(task);
  if (override) return { ...override, ...publicData };
  return { model: def.model, fallbacks: def.fallbacks, temperature: def.temperature, maxTokens: def.maxTokens, ...publicData };
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
