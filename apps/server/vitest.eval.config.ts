import { defineConfig } from "vitest/config";

/**
 * Conversas de referência com o modelo de verdade (OpenRouter), fora da suíte normal: `npm run eval -w apps/server`.
 * Precisa de EVAL_OPENROUTER_API_KEY (no GitHub: segredo OPENROUTER_API_KEY), TEST_DATABASE_URL e REDIS_URL.
 * Usa as rotas padrão de modelo (ROUTE_DEFAULTS), não as que o dono trocou na tela Modelos.
 */
export default defineConfig({
  test: {
    include: ["eval/**/*.eval.ts"],
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 60_000,
    setupFiles: ["./test/setup.ts"],
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/planejai_test_unavailable",
      APP_SECRET: "eval-secret-eval-secret-eval-secret-xx",
      ADMIN_PASSWORD: "eval-password",
      INTERNAL_API_KEY: "eval-internal-key-eval-internal-key",
      OPENROUTER_API_KEY: process.env.EVAL_OPENROUTER_API_KEY ?? "",
      OPENROUTER_BASE_URL: process.env.EVAL_OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
      WHATSAPP_PROVIDER: "none",
      LOG_LEVEL: "silent",
      INVITE_GAP_SECONDS: "0",
      NEW_CONTACT_GAP_SECONDS: "0",
      LOGIN_CODE: "false",
      DEFAULT_TIMEZONE: "America/Sao_Paulo",
    },
  },
});
