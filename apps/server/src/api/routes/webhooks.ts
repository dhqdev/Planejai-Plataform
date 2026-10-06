import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { channels } from "../../channels/index.js";
import { config } from "../../config.js";
import { ingest } from "../../ingest.js";

function secretOk(req: FastifyRequest) {
  if (!config.WEBHOOK_SECRET) return true;
  const q = (req.query as any)?.secret;
  const h = req.headers["x-webhook-secret"];
  return q === config.WEBHOOK_SECRET || h === config.WEBHOOK_SECRET;
}

export async function registerWebhookRoutes(app: FastifyInstance) {
  // Evolution API: configure o webhook da instância para {PUBLIC_URL}/webhooks/evolution?secret=WEBHOOK_SECRET
  // com o evento MESSAGES_UPSERT (e, opcionalmente, "webhook base64" ligado).
  app.post("/webhooks/evolution", async (req, reply) => {
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

  // WhatsApp Cloud API (Meta): verificação do webhook
  app.get("/webhooks/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === config.WHATSAPP_CLOUD_VERIFY_TOKEN) {
      return reply.type("text/plain").send(q["hub.challenge"]);
    }
    return reply.code(403).send("forbidden");
  });

  app.post("/webhooks/whatsapp", async (req, reply) => {
    if (config.WHATSAPP_CLOUD_APP_SECRET) {
      const sig = String(req.headers["x-hub-signature-256"] ?? "");
      const expected = "sha256=" + createHmac("sha256", config.WHATSAPP_CLOUD_APP_SECRET).update((req as any).rawBody ?? "").digest("hex");
      if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        return reply.code(401).send({ error: "assinatura inválida" });
      }
    }
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
