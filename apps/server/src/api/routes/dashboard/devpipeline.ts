import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { answerTicket, cancelTicket, costOverview, createTicket, devStatus, getTicket, listTickets, retryTicket, saveDevSettings } from "../../../devpipeline/pipeline.js";

/** Só o dono da stack (não basta ser super admin): a esteira escreve no repositório dele. */
async function requireOwner(req: FastifyRequest, reply: FastifyReply) {
  if (!req.account?.owner) return reply.code(403).send({ error: "Só o dono pode usar a esteira" });
}

const idOf = (raw: string) => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);

/** Esteira de desenvolvimento (tela Esteira): chamados, linha do tempo de cada um e custos. */
export async function devPipelineRoutes(api: FastifyInstance) {
  await api.register(async (dev) => {
    dev.addHook("preHandler", requireOwner);

    dev.get<{ Querystring: { fresh?: string } }>("/api/dev/status", async (req) => devStatus(req.query.fresh === "1"));

    /** Repositório, branch base e limite de custo, salvos na própria tela (o token vem de Integrações). */
    dev.put<{ Body: { repo?: string; base_branch?: string; cost_cap?: string } }>("/api/dev/settings", async (req, reply) => {
      const repo = String(req.body?.repo ?? "").trim();
      if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""))) return reply.code(400).send({ error: "Repositório no formato dono/repositorio." });
      await saveDevSettings({ repo: repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""), base_branch: req.body?.base_branch, cost_cap: req.body?.cost_cap });
      return devStatus(true);
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
