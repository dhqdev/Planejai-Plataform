import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { answerTicket, cancelTicket, costOverview, createTicket, devConfig, getTicket, listTickets, retryTicket, STAGE_LABEL } from "../../../devpipeline/pipeline.js";

/** Só o dono da stack (não basta ser super admin): a esteira escreve no repositório dele. */
async function requireOwner(req: FastifyRequest, reply: FastifyReply) {
  if (!req.account?.owner) return reply.code(403).send({ error: "Só o dono pode usar a esteira" });
}

const idOf = (raw: string) => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);

/** Esteira de desenvolvimento (tela Esteira): chamados, linha do tempo de cada um e custos. */
export async function devPipelineRoutes(api: FastifyInstance) {
  await api.register(async (dev) => {
    dev.addHook("preHandler", requireOwner);

    dev.get("/api/dev/status", async () => {
      const cfg = await devConfig();
      return "missing" in cfg
        ? { ready: false, missing: cfg.missing, stages: STAGE_LABEL }
        : { ready: true, repo: `${cfg.gh.repo.owner}/${cfg.gh.repo.name}`, base: cfg.base, costCap: cfg.costCap, stages: STAGE_LABEL };
    });

    dev.get("/api/dev/tickets", async () => listTickets());

    dev.post<{ Body: { title?: string; description?: string; kind?: string } }>("/api/dev/tickets", async (req, reply) => {
      const title = String(req.body?.title ?? "").trim();
      const description = String(req.body?.description ?? "").trim();
      if (title.length < 3 || description.length < 10) return reply.code(400).send({ error: "Dê um título e conte o que precisa (pelo menos uma frase)." });
      return { id: await createTicket({ title, description, kind: req.body?.kind }) };
    });

    dev.get<{ Params: { id: string } }>("/api/dev/tickets/:id", async (req, reply) => {
      const id = idOf(req.params.id);
      const t = id ? await getTicket(id) : null;
      return t ?? reply.code(404).send({ error: "chamado não encontrado" });
    });

    dev.post<{ Params: { id: string } }>("/api/dev/tickets/:id/retry", async (req, reply) => {
      const id = idOf(req.params.id);
      return id && (await retryTicket(id)) ? { ok: true } : reply.code(409).send({ error: "Esse chamado não está parado." });
    });

    dev.post<{ Params: { id: string } }>("/api/dev/tickets/:id/cancel", async (req, reply) => {
      const id = idOf(req.params.id);
      return id && (await cancelTicket(id)) ? { ok: true } : reply.code(409).send({ error: "Esse chamado já terminou." });
    });

    dev.post<{ Params: { id: string }; Body: { text?: string } }>("/api/dev/tickets/:id/answer", async (req, reply) => {
      const id = idOf(req.params.id);
      const text = String(req.body?.text ?? "").trim();
      if (!text) return reply.code(400).send({ error: "Escreva a resposta." });
      return id && (await answerTicket(id, text)) ? { ok: true } : reply.code(409).send({ error: "Esse chamado não está esperando resposta." });
    });

    dev.get<{ Querystring: { days?: string } }>("/api/dev/costs", async (req) => costOverview(Number(req.query.days ?? 30)));
  });
}
