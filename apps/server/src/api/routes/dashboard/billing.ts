import type { FastifyInstance } from "fastify";
import { billingAccess, billingOverview, cancelSubscription, getSubscription, planOf, subscribe, trialEnd } from "../../../billing.js";
import { config } from "../../../config.js";
import { one, query } from "../../../db/pool.js";
import { isConnected } from "../../../integrations/registry.js";
import { getSettings } from "../../../settings.js";
import { isUuid } from "./shared.js";

/** Assinatura de quem está logado: ver o plano, assinar e cancelar. */
export function billingRoutes(base: FastifyInstance) {
  base.get("/api/billing", async (req) => {
    const s = await getSettings();
    const plan = planOf(s);
    const uid = req.account.userId;
    if (!uid) return { plan, linked: false };
    const user = await one("SELECT * FROM users WHERE id = $1", [uid]);
    if (!user) return { plan, linked: false };
    const sub = await getSubscription(uid);
    const access = await billingAccess(user, s);
    return {
      plan,
      linked: true,
      ready: plan.enabled && (await isConnected("asaas")),
      name: user.full_name ?? user.name ?? "",
      email: user.email ?? req.account.email ?? "",
      trialEndsAt: trialEnd(user, s).toISOString(),
      access: { allowed: access.allowed, state: access.state, until: access.allowed && access.until ? access.until.toISOString() : null },
      subscription: sub && { status: sub.status, value: Number(sub.value), nextDueDate: sub.next_due_date, paidUntil: sub.paid_until, lastPaymentAt: sub.last_payment_at, invoiceUrl: sub.invoice_url },
    };
  });

  base.post<{ Body: { name?: string; cpfCnpj?: string; email?: string } }>("/api/billing/subscribe", async (req, reply) => {
    const uid = req.account.userId;
    if (!uid) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil antes de assinar." });
    const user = await one("SELECT * FROM users WHERE id = $1", [uid]);
    if (!user) return reply.code(404).send({ error: "Pessoa não encontrada." });
    try {
      const sub = await subscribe(user, { name: String(req.body?.name ?? ""), cpfCnpj: String(req.body?.cpfCnpj ?? ""), email: req.body?.email ?? user.email ?? req.account.email });
      return { ok: true, status: sub.status, nextDueDate: sub.next_due_date, invoiceUrl: sub.invoice_url };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  base.post("/api/billing/cancel", async (req, reply) => {
    const uid = req.account.userId;
    if (!uid) return reply.code(400).send({ error: "Sem assinatura nesta conta." });
    try {
      await cancelSubscription(uid);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}

/** Visão do dono: quem está nos dias grátis, em dia, travado ou liberado sem pagar. */
export function billingAdminRoutes(api: FastifyInstance) {
  api.get("/api/billing/admin", async () => ({
    ...(await billingOverview()),
    connected: await isConnected("asaas"),
    webhookUrl: `${config.PUBLIC_URL.replace(/\/$/, "")}/webhooks/asaas`,
  }));

  // liberar alguém sem cobrança (família, parceiro, teste)
  api.patch<{ Params: { id: string }; Body: { exempt?: boolean } }>("/api/billing/people/:id", async (req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "Pessoa não encontrada." });
    const r = await query("UPDATE users SET billing_exempt = $2 WHERE id = $1", [req.params.id, req.body?.exempt === true]);
    if (!r.rowCount) return reply.code(404).send({ error: "Pessoa não encontrada." });
    return { ok: true };
  });
}
