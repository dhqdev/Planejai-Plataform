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

  // Segredo usado para criptografar credenciais de integrações e assinar sessões do dashboard.
  APP_SECRET: z.string().min(32, "APP_SECRET precisa ter pelo menos 32 caracteres"),
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

  // Números (só dígitos, com DDI) que podem falar com o agente sem aprovação.
  OWNER_PHONES: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((p) => p.replace(/\D/g, "")).filter(Boolean)),
  ALLOW_UNKNOWN_CONTACTS: bool,
  DEFAULT_TIMEZONE: z.string().default("America/Sao_Paulo"),

  // Tempo (s) esperando mensagens seguidas antes de responder, como uma pessoa lendo tudo.
  MESSAGE_DEBOUNCE_SECONDS: z.coerce.number().default(2),

  // Serviço opcional de navegador headless (browserless) para screenshots de páginas.
  BROWSERLESS_URL: z.string().default(""),
  BROWSERLESS_TOKEN: z.string().default(""),
  // Chrome local (só desenvolvimento): usado pelo navegador dos agentes quando não há browserless
  CHROME_PATH: z.string().default(""),

  // Redis próprio da stack: memória curta das conversas (some sozinha depois de MESSAGE_RETENTION_HOURS)
  REDIS_URL: z.string().default(""),
  // Mensagens brutas ficam esse tempo (Redis e Postgres); depois viram resumo e são apagadas
  MESSAGE_RETENTION_HOURS: z.coerce.number().default(24),
  EXECUTION_RETENTION_DAYS: z.coerce.number().default(7),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  return parsed.data;
}

export const config: Config = loadConfig();
