import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/planejai_test_unavailable",
      APP_SECRET: "test-secret-test-secret-test-secret-xx",
      ADMIN_PASSWORD: "test-password",
      INTERNAL_API_KEY: "test-internal-key-test-internal-key",
      OPENROUTER_API_KEY: "test",
      OPENROUTER_BASE_URL: "http://127.0.0.1:4599",
      WHATSAPP_PROVIDER: "none",
      LOG_LEVEL: "silent",
      // os testes sobem servidores falsos em 127.0.0.1; a trava de SSRF tem teste próprio (unit.test.ts)
      ALLOW_PRIVATE_URLS: "true",
      INVITE_GAP_SECONDS: "0",
      // código no WhatsApp ao entrar de navegador novo tem teste próprio (logincode.test.ts)
      LOGIN_CODE: "false",
    },
  },
});
