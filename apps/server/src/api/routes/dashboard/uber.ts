import type { FastifyInstance } from "fastify";
import { hit } from "../../../ratelimit.js";
import { handleShortcutCode } from "../../../uber.js";

/**
 * Uber (beta): o Atalho do iPhone (ou app de encaminhar SMS no Android) manda aqui o SMS da Uber e o código vai
 * direto para o robô que está esperando. Sem login: quem autoriza é o token pessoal que o Juvenal mandou (só o hash fica no banco).
 */
export function uberPublicRoutes(app: FastifyInstance) {
  app.post<{ Querystring: { t?: string }; Body: { texto?: string; text?: string; t?: string } | string }>("/api/uber/codigo", async (req, reply) => {
    if ((await hit(`uber-code:${req.ip}`, 60)) > 20) return reply.code(429).send({ ok: false, error: "Calma: muitas tentativas" });
    const body = typeof req.body === "string" ? { texto: req.body } : (req.body ?? {});
    const token = String(req.query?.t ?? body.t ?? "");
    const text = String(body.texto ?? body.text ?? "").slice(0, 2000);
    const r = await handleShortcutCode(token, text);
    if (!r.ok) return reply.code(401).send({ ok: false, error: "Atalho desconectado: peça um novo no WhatsApp" });
    return { ok: true, used: r.used };
  });
}
