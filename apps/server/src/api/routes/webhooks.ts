import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { channels } from "../../channels/index.js";
import { handleAsaasEvent } from "../../billing.js";
import { config } from "../../config.js";
import { ingest } from "../../ingest.js";
import { getCredentials } from "../../integrations/registry.js";
import { handleTelegramUpdate, telegramSecretOk } from "../../telegram.js";

/** Comparação em tempo constante; segredo vazio nunca confere. */
function sameSecret(got: unknown, expected: string) {
  if (!expected || typeof got !== "string" || !got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Evolution: exige WEBHOOK_SECRET (sem segredo, qualquer um que soubesse a URL mandava mensagem falsa). */
function secretOk(req: FastifyRequest) {
  return sameSecret((req.query as any)?.secret, config.WEBHOOK_SECRET) || sameSecret(req.headers["x-webhook-secret"], config.WEBHOOK_SECRET);
}

/**
 * Webhook de canal que não está em uso fica fechado: com o Baileys ligado, um POST no formato da Meta
 * ou da Evolution com o número do dono não pode virar mensagem "do dono".
 */
const off = (provider: string) => config.WHATSAPP_PROVIDER !== provider;

export async function registerWebhookRoutes(app: FastifyInstance) {
  // Evolution API: configure o webhook da instância para {PUBLIC_URL}/webhooks/evolution?secret=WEBHOOK_SECRET
  // com o evento MESSAGES_UPSERT (e, opcionalmente, "webhook base64" ligado).
  app.post("/webhooks/evolution", async (req, reply) => {
    if (off("evolution")) return reply.code(404).send({ error: "canal desligado" });
    if (!secretOk(req)) return reply.code(401).send({ error: "secret inválido" });
    const msgs = channels.evolution!.parseWebhook(req.body);
    const results = [];
    for (const m of msgs) {
      try {
        results.push(await ingest(m));
      } catch (err) {
        req.log.error({ err }, "falha ao ingerir mensagem");
      }
    }
    return { ok: true, received: msgs.length, results };
  });

  // Asaas: avisos de pagamento da assinatura. O token é o que o dono colou em Integrações > Asaas e no webhook do Asaas.
  app.post("/webhooks/asaas", async (req, reply) => {
    const token = (await getCredentials("asaas"))?.webhook_token ?? "";
    if (!sameSecret(req.headers["asaas-access-token"], token)) return reply.code(401).send({ error: "token inválido" });
    try {
      return { ok: true, ...(await handleAsaasEvent(req.body)) };
    } catch (err) {
      // 500 faz o Asaas tentar de novo mais tarde
      req.log.error({ err }, "falha no evento do Asaas");
      return reply.code(500).send({ error: "falha ao processar" });
    }
  });

  // Telegram: o setWebhook (ao salvar o token em Integrações) manda o segredo no cabeçalho
  app.post("/webhooks/telegram", async (req, reply) => {
    if (!telegramSecretOk(req.headers["x-telegram-bot-api-secret-token"])) return reply.code(401).send({ error: "segredo inválido" });
    // responde logo; o Telegram reenvia se demorar
    void handleTelegramUpdate(req.body).catch((err) => req.log.error({ err }, "falha no update do Telegram"));
    return { ok: true };
  });

  // WhatsApp Cloud API (Meta): verificação do webhook
  app.get("/webhooks/whatsapp", async (req, reply) => {
    if (off("cloud")) return reply.code(404).send("canal desligado");
    const q = req.query as Record<string, string>;
    if (q["hub.mode"] === "subscribe" && sameSecret(q["hub.verify_token"], config.WHATSAPP_CLOUD_VERIFY_TOKEN)) {
      return reply.type("text/plain").send(q["hub.challenge"]);
    }
    return reply.code(403).send("forbidden");
  });

  app.post("/webhooks/whatsapp", async (req, reply) => {
    if (off("cloud")) return reply.code(404).send({ error: "canal desligado" });
    // sem o App Secret não dá para provar que veio da Meta: recusa em vez de aceitar sem assinatura
    if (!config.WHATSAPP_CLOUD_APP_SECRET) return reply.code(503).send({ error: "configure WHATSAPP_CLOUD_APP_SECRET" });
    const expected = "sha256=" + createHmac("sha256", config.WHATSAPP_CLOUD_APP_SECRET).update((req as any).rawBody ?? "").digest("hex");
    if (!sameSecret(String(req.headers["x-hub-signature-256"] ?? ""), expected)) return reply.code(401).send({ error: "assinatura inválida" });
    const msgs = channels.cloud!.parseWebhook(req.body);
    for (const m of msgs) {
      try {
        await ingest(m);
      } catch (err) {
        req.log.error({ err }, "falha ao ingerir mensagem");
      }
    }
    return { ok: true };
  });
}
