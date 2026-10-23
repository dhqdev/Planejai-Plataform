import type { FastifyInstance } from "fastify";
import { CheckoutError, checkoutBoleto, checkoutCard, checkoutPix, checkoutStatus, checkoutView } from "../../checkout.js";
import { hit } from "../../ratelimit.js";

/**
 * Checkout público (/pagar/<token>): o link vai no WhatsApp e no painel e abre sem login. O token assinado diz qual
 * cobrança é; o cartão tem limite apertado de tentativas (por cobrança e por IP) para ninguém testar cartão aqui.
 */
export async function registerCheckoutRoutes(app: FastifyInstance) {
  const tooMany = (reply: any) => reply.code(429).send({ error: "Muitas tentativas. Espere um pouco e tente de novo." });
  const run = async (reply: any, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CheckoutError) return reply.code(err.status).send({ error: err.message });
      return reply.code(400).send({ error: (err as Error).message || "Não deu certo agora. Tente de novo." });
    }
  };

  app.get<{ Params: { token: string } }>("/api/pay/:token", async (req, reply) => {
    if ((await hit(`pagar:ver:${req.ip}`, 300)) > 120) return tooMany(reply);
    return run(reply, () => checkoutView(req.params.token));
  });

  // a tela confere a cada poucos segundos enquanto espera o Pix ou o boleto
  app.get<{ Params: { token: string } }>("/api/pay/:token/status", async (req, reply) => {
    if ((await hit(`pagar:status:${req.ip}`, 300)) > 200) return tooMany(reply);
    return run(reply, () => checkoutStatus(req.params.token));
  });

  app.post<{ Params: { token: string } }>("/api/pay/:token/pix", async (req, reply) => {
    if ((await hit(`pagar:gerar:${req.ip}`, 300)) > 30) return tooMany(reply);
    return run(reply, () => checkoutPix(req.params.token));
  });

  app.post<{ Params: { token: string } }>("/api/pay/:token/boleto", async (req, reply) => {
    if ((await hit(`pagar:gerar:${req.ip}`, 300)) > 30) return tooMany(reply);
    return run(reply, () => checkoutBoleto(req.params.token));
  });

  app.post<{ Params: { token: string }; Body: Record<string, string> }>("/api/pay/:token/card", async (req, reply) => {
    if ((await hit(`pagar:cartao:${req.ip}`, 3600)) > 10 || (await hit(`pagar:cartao:${req.params.token}`, 3600)) > 6) return tooMany(reply);
    return run(reply, () => checkoutCard(req.params.token, req.body ?? {}, req.ip));
  });
}
