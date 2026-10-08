import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v?.toLowerCase() === "true");

const schema = z.object({
  NODE_ENV: z.string().default("production"),
  ROLE: z.enum(["all", "api", "worker"]).default("all"),
  PORT: z.coerce.number().default(3000),
  PUBLIC_URL: z.string().default("http://localhost:3000"),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL é obrigatório"),

  // Segredos separados: se um vazar, os outros continuam valendo e dá para trocar só ele.
  // SESSION_SECRET assina o login do painel (trocar = todo mundo entra de novo).
  SESSION_SECRET: z.string().default(""),
  // ENCRYPTION_KEY criptografa as credenciais das integrações. Para trocar sem perder nada, mova a atual
  // para ENCRYPTION_KEY_OLD: no boot tudo é recriptografado com a nova.
  ENCRYPTION_KEY: z.string().default(""),
  ENCRYPTION_KEY_OLD: z.string().default(""),
  // Legado: antes um segredo só fazia tudo. Ainda serve de reserva para quem não definiu os novos.
  APP_SECRET: z.string().default(""),
  ADMIN_EMAIL: z.string().default("admin@planejai.local"),
  ADMIN_PASSWORD: z.string().min(8, "ADMIN_PASSWORD precisa ter pelo menos 8 caracteres"),

  OPENROUTER_API_KEY: z.string().default(""),
  OPENROUTER_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),

  // Canal WhatsApp: "baileys" (conexão própria por QR code, embutida), "evolution" (Evolution API)
  // ou "cloud" (API oficial da Meta).
  WHATSAPP_PROVIDER: z.enum(["baileys", "evolution", "cloud", "none"]).default("baileys"),
  EVOLUTION_API_URL: z.string().default(""),
  EVOLUTION_API_KEY: z.string().default(""),
  EVOLUTION_INSTANCE: z.string().default(""),
  WHATSAPP_CLOUD_TOKEN: z.string().default(""),
  WHATSAPP_CLOUD_PHONE_NUMBER_ID: z.string().default(""),
  WHATSAPP_CLOUD_VERIFY_TOKEN: z.string().default(""),
  WHATSAPP_CLOUD_APP_SECRET: z.string().default(""),
  WEBHOOK_SECRET: z.string().default(""),
  /** chave da API interna (n8n e automações); vazia = API interna desligada. Aparece em Integrações > n8n */
  INTERNAL_API_KEY: z.string().default(""),
  // n8n na mesma rede da stack: preenchido aqui, a integração já nasce conectada (sem tela de Integrações)
  N8N_URL: z.string().default(""),
  N8N_API_KEY: z.string().default(""),
  /** busca web da Tavily pela stack (sem precisar colar na tela de Integrações) */
  TAVILY_API_KEY: z.string().default(""),
  N8N_EVENTS_URL: z.string().default(""),
  // automações que cada cliente pode ter ativas no n8n (criadas pelo assistente)
  // Login em navegador novo pede um código no WhatsApp da pessoa (desligue com LOGIN_CODE=false)
  LOGIN_CODE: z
    .string()
    .default("true")
    .transform((v) => !["0", "false", "no", "nao", "não"].includes(v.trim().toLowerCase())),
  AUTOMATIONS_PER_USER: z.coerce.number().int().min(0).max(50).default(5),

  // Números (só dígitos, com DDI) que podem falar com o agente sem aprovação.
  OWNER_PHONES: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((p) => p.replace(/\D/g, "")).filter(Boolean)),
  ALLOW_UNKNOWN_CONTACTS: bool,
  DEFAULT_TIMEZONE: z.string().default("America/Sao_Paulo"),

  // Tempo (s) esperando mensagens seguidas antes de responder, como uma pessoa lendo tudo.
  MESSAGE_DEBOUNCE_SECONDS: z.coerce.number().default(2),
  // Teto de convites enviados pelo número do assistente em 24h (protege o número contra banimento)
  INVITES_PER_DAY: z.coerce.number().int().min(1).default(40),
  // Intervalo mínimo (s) entre dois convites enviados
  INVITE_GAP_SECONDS: z.coerce.number().min(0).default(45),
  // conversas processadas ao mesmo tempo por worker (como o --concurrency do n8n em modo fila)
  // (até 16: cada conversa rodando segura uma conexão do banco; o pool cresce junto, ver db/pool.ts)
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),

  // Serviço opcional de navegador headless (browserless) para screenshots de páginas.
  BROWSERLESS_URL: z.string().default(""),
  BROWSERLESS_TOKEN: z.string().default(""),
  // Chrome local (só desenvolvimento): usado pelo navegador dos agentes quando não há browserless
  CHROME_PATH: z.string().default(""),
  // Só para desenvolvimento/testes: deixa os agentes abrirem endereços internos (localhost, IPs privados)
  ALLOW_PRIVATE_URLS: bool,

  // Redis próprio da stack: memória curta das conversas (some sozinha depois de MESSAGE_RETENTION_HOURS)
  REDIS_URL: z.string().default(""),
  // Redis de cache (opcional, com despejo LRU): buscas, páginas e mídia interpretada. Vazio = usa o REDIS_URL
  REDIS_CACHE_URL: z.string().default(""),
  // Mensagens brutas ficam esse tempo (Redis e Postgres); depois viram resumo e são apagadas
  MESSAGE_RETENTION_HOURS: z.coerce.number().default(24),
  EXECUTION_RETENTION_DAYS: z.coerce.number().default(7),
  // Texto das conversas nos logs de execução (entrada, mensagens mandadas ao modelo, respostas) só fica esse tempo;
  // depois o log guarda só custo, tempo, modelo e ferramentas usadas
  LOG_CONTENT_HOURS: z.coerce.number().min(1).default(24),
});

const checked = schema.superRefine((c, ctx) => {
  const need = (name: string, value: string) => {
    if (value.length < 32) ctx.addIssue({ code: "custom", path: [name], message: `${name} precisa ter pelo menos 32 caracteres (gere com: openssl rand -hex 32)` });
  };
  need(c.SESSION_SECRET ? "SESSION_SECRET" : "APP_SECRET", c.SESSION_SECRET || c.APP_SECRET);
  need(c.ENCRYPTION_KEY ? "ENCRYPTION_KEY" : "APP_SECRET", c.ENCRYPTION_KEY || c.APP_SECRET);
  if (c.INTERNAL_API_KEY && c.INTERNAL_API_KEY.length < 24) ctx.addIssue({ code: "custom", path: ["INTERNAL_API_KEY"], message: "INTERNAL_API_KEY precisa ter pelo menos 24 caracteres" });
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = checked.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  return parsed.data;
}

export const config: Config = loadConfig();
