import type { FastifyInstance } from "fastify";
import { serverOverview, storageByClient } from "../../../resources.js";

/** Tela Servidor (só super admin): memória e CPU, banco, Redis, disco e quanto cada cliente ocupa (só tamanhos). */
export function resourceRoutes(api: FastifyInstance) {
  api.get("/api/resources", async () => serverOverview());
  api.get<{ Querystring: { fresh?: string } }>("/api/resources/storage", async (req) => storageByClient(req.query.fresh === "1"));
}
