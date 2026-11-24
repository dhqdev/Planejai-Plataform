import type { FastifyInstance } from "fastify";
import { config } from "../../../config.js";
import { serverOverview, storageByClient } from "../../../resources.js";
import { saveSettings } from "../../../settings.js";
import { fileLocations, keepLocalCopy, storageOn } from "../../../storage.js";

/** Tela Servidor (só super admin): memória e CPU, banco, Redis, disco e quanto cada cliente ocupa (só tamanhos). */
export function resourceRoutes(api: FastifyInstance) {
  api.get("/api/resources", async () => serverOverview());
  api.get<{ Querystring: { fresh?: string } }>("/api/resources/storage", async (req) => storageByClient(req.query.fresh === "1"));

  // Onde ficam os arquivos: cópia na VM (banco + dump local) ou só no bucket
  const files = async () => ({
    bucket: (await storageOn()) ? { host: new URL(config.STORAGE_S3_ENDPOINT).host, name: config.STORAGE_S3_BUCKET } : null,
    keepLocalCopy: await keepLocalCopy(),
    ...(await fileLocations()),
  });
  api.get("/api/resources/files", files);
  api.put<{ Body: { keepLocalCopy?: unknown } }>("/api/resources/files", async (req, reply) => {
    const keep = req.body?.keepLocalCopy === true;
    if (!keep && !(await storageOn())) return reply.code(400).send({ error: "Sem bucket configurado (STORAGE_S3_*), ou com ele desconectado, os arquivos só podem ficar na VM." });
    await saveSettings({ keepLocalCopy: keep });
    return files();
  });
}
