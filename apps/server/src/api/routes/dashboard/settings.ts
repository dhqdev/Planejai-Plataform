import type { FastifyInstance } from "fastify";
import { activeChannel } from "../../../channels/index.js";
import { config } from "../../../config.js";
import { listModels } from "../../../llm/openrouter.js";
import { listRoutes, resetRoute, saveRoute } from "../../../llm/router.js";
import { getSettings, saveSettings } from "../../../settings.js";

/** Configurações e rotas de modelos (só super admin). */
export function settingsRoutes(api: FastifyInstance) {
  // ---------- Configurações ----------
  api.get("/api/settings", async () => {
    const ch = activeChannel();
    const base = config.PUBLIC_URL.replace(/\/$/, "");
    return {
      settings: await getSettings(),
      channel: {
        provider: config.WHATSAPP_PROVIDER,
        configured: ch?.configured() ?? false,
        webhookUrl:
          config.WHATSAPP_PROVIDER === "baileys" || config.WHATSAPP_PROVIDER === "none"
            ? null
            : config.WHATSAPP_PROVIDER === "cloud"
            ? `${base}/webhooks/whatsapp`
            : `${base}/webhooks/evolution${config.WEBHOOK_SECRET ? "?secret=<WEBHOOK_SECRET>" : ""}`,
      },
      ownerPhones: config.OWNER_PHONES,
      allowUnknown: config.ALLOW_UNKNOWN_CONTACTS,
      openrouter: Boolean(config.OPENROUTER_API_KEY),
    };
  });
  api.put<{ Body: Record<string, unknown> }>("/api/settings", async (req, reply) => {
    try {
      return await saveSettings(req.body as any);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  api.get("/api/models/routes", async () => listRoutes());
  api.put<{ Params: { task: string }; Body: { model: string; fallbacks?: string[]; temperature?: number | null; maxTokens?: number | null } }>(
    "/api/models/routes/:task",
    async (req, reply) => {
      if (!req.body.model) return reply.code(400).send({ error: "model é obrigatório" });
      await saveRoute(req.params.task, req.body);
      return { ok: true };
    },
  );
  api.delete<{ Params: { task: string } }>("/api/models/routes/:task", async (req) => {
    await resetRoute(req.params.task);
    return { ok: true };
  });
  api.get("/api/models/catalog", async (_req, reply) => {
    try {
      return await listModels();
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
