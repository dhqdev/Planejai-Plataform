import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  asaasMode,
  billingAccess,
  billingOverview,
  buyPack,
  cancelSubscription,
  changePlan,
  getSubscription,
  hasPlan,
  pricingOf,
  referralDiscount,
  subscribe,
  withDiscount,
} from "../../../billing.js";
import { config } from "../../../config.js";
import { creditGrains, dailyBurn, ensureWallet, grainsExempt, ledgerOf, planById } from "../../../credits.js";
import { many, one, query } from "../../../db/pool.js";
import { isConnected } from "../../../integrations/registry.js";
import { getSettings } from "../../../settings.js";
import { isUuid } from "./shared.js";

const fail = (reply: any, err: unknown) => reply.code(400).send({ error: (err as Error).message });

/** Plano e grãos de quem está logado: saldo, extrato, vitrine, assinar, trocar, comprar pacote e cancelar. */
export function billingRoutes(base: FastifyInstance) {
  const me = async (req: any) => {
    const uid = req.account.userId;
    return uid ? one("SELECT * FROM users WHERE id = $1", [uid]) : null;
  };

  base.get("/api/billing", async (req) => {
    const s = await getSettings();
    const pricing = pricingOf(s);
    const user = await me(req);
    if (!user) return { pricing, linked: false };
    const [wallet, ledger, burn, sub, access, referral] = await Promise.all([
      ensureWallet(user.id, s),
      ledgerOf(user.id, 30),
      dailyBurn(user.id),
      getSubscription(user.id),
      billingAccess(user, s),
      referralDiscount(user.id, s),
    ]);
    // amigos que a pessoa trouxe: quem já paga conta para o desconto
    const friends = await many(
      `SELECT COALESCE(u.full_name, u.name, 'Amigo') AS name, (s.status = 'active' AND s.asaas_subscription_id IS NOT NULL) AS paying
         FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
        WHERE u.invited_by = $1 AND u.id <> $1 AND u.status = 'active' ORDER BY u.created_at DESC LIMIT 50`,
      [user.id],
    );
    const plan = hasPlan(sub) ? planById(s, sub.plan_id) : null;
    const nextPlan = hasPlan(sub) ? planById(s, sub.next_plan_id) : null;
    const pending = await many(
      "SELECT kind, item_id, grains, value, invoice_url, created_at FROM grain_purchases WHERE user_id = $1 AND status = 'pending' AND created_at > now() - interval '1 day' ORDER BY created_at DESC LIMIT 3",
      [user.id],
    );
    return {
      pricing,
      linked: true,
      ready: pricing.enabled && (await isConnected("asaas")),
      exempt: grainsExempt(user, s),
      name: user.full_name ?? user.name ?? "",
      email: user.email ?? req.account.email ?? "",
      wallet,
      burnPerDay: Math.round(burn),
      access: { allowed: access.allowed, state: access.state },
      ledger,
      pending: pending.map((p) => ({ kind: p.kind, itemId: p.item_id, grains: Number(p.grains), value: Number(p.value), invoiceUrl: p.invoice_url })),
      subscription: hasPlan(sub)
        ? {
            status: sub.status,
            plan: plan && { id: plan.id, name: plan.name, grains: plan.grains, price: plan.price },
            nextPlan: nextPlan && { id: nextPlan.id, name: nextPlan.name },
            value: Number(sub.value),
            discount: Number(sub.discount_percent ?? 0),
            method: sub.pay_method,
            card: sub.card_last4 ? { brand: sub.card_brand, last4: sub.card_last4 } : null,
            nextDueDate: sub.next_due_date,
            lastPaymentAt: sub.last_payment_at,
            invoiceUrl: sub.invoice_url,
          }
        : null,
      referral: {
        ...referral,
        // quanto a mensalidade cai com mais um amigo pagando
        next: referral.step > 0 && referral.percent < referral.max ? Math.min(referral.max, referral.percent + referral.step) : null,
        friends: friends.map((f) => ({ name: String(f.name).split(" ")[0], paying: Boolean(f.paying) })),
        prices: pricing.plans.map((p) => ({ id: p.id, price: p.price, withDiscount: withDiscount(p.price, referral.percent) })),
      },
    };
  });

  base.post<{ Body: { planId?: string; method?: string; name?: string; cpfCnpj?: string; email?: string } }>("/api/billing/subscribe", async (req, reply) => {
    const user = await me(req);
    if (!user) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil antes de assinar." });
    try {
      const sub = await subscribe(user, {
        planId: String(req.body?.planId ?? ""),
        method: req.body?.method === "pix" ? "pix" : "card",
        name: String(req.body?.name ?? ""),
        cpfCnpj: String(req.body?.cpfCnpj ?? ""),
        email: req.body?.email ?? user.email ?? req.account.email,
      });
      return { ok: true, status: sub.status, nextDueDate: sub.next_due_date, invoiceUrl: sub.invoice_url };
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.post<{ Body: { planId?: string } }>("/api/billing/change-plan", async (req, reply) => {
    const user = await me(req);
    if (!user) return reply.code(400).send({ error: "Sem plano nesta conta." });
    try {
      const r = await changePlan(user, String(req.body?.planId ?? ""));
      return { ok: true, kind: r.kind, invoiceUrl: r.invoiceUrl ?? null, plan: r.plan.name };
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.post<{ Body: { packId?: string; name?: string; cpfCnpj?: string; email?: string } }>("/api/billing/pack", async (req, reply) => {
    const user = await me(req);
    if (!user) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil antes de comprar." });
    try {
      const p = await buyPack(user, String(req.body?.packId ?? ""), {
        name: req.body?.name,
        cpfCnpj: req.body?.cpfCnpj,
        email: req.body?.email ?? user.email ?? req.account.email,
      });
      return { ok: true, invoiceUrl: p.invoice_url, value: Number(p.value), grains: Number(p.grains) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.post("/api/billing/cancel", async (req, reply) => {
    const uid = req.account.userId;
    if (!uid) return reply.code(400).send({ error: "Sem plano nesta conta." });
    try {
      await cancelSubscription(uid);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });
}

/** Visão do dono: quem tem plano, quem está nos grãos grátis, quem zerou e quem está liberado. */
export function billingAdminRoutes(api: FastifyInstance) {
  api.get("/api/billing/admin", async () => ({
    ...(await billingOverview()),
    connected: await isConnected("asaas"),
    // chave errada cai no sandbox sem ninguém ser cobrado de verdade: a tela mostra qual está valendo
    mode: await asaasMode(),
    webhookUrl: `${config.PUBLIC_URL.replace(/\/$/, "")}/webhooks/asaas`,
  }));

  // liberar alguém sem cobrança (família, parceiro, teste)
  api.patch<{ Params: { id: string }; Body: { exempt?: boolean } }>("/api/billing/people/:id", async (req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "Pessoa não encontrada." });
    const r = await query("UPDATE users SET billing_exempt = $2 WHERE id = $1", [req.params.id, req.body?.exempt === true]);
    if (!r.rowCount) return reply.code(404).send({ error: "Pessoa não encontrada." });
    return { ok: true };
  });

  // dar grãos de presente (compensar um problema, cortesia)
  api.post<{ Params: { id: string }; Body: { amount?: number; note?: string } }>("/api/billing/people/:id/grains", async (req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "Pessoa não encontrada." });
    const amount = Math.round(Number(req.body?.amount));
    if (!(amount >= 1 && amount <= 100_000)) return reply.code(400).send({ error: "Informe de 1 a 100.000 grãos." });
    if (!(await one("SELECT 1 FROM users WHERE id = $1", [req.params.id]))) return reply.code(404).send({ error: "Pessoa não encontrada." });
    const wallet = await creditGrains(req.params.id, { amount, bucket: "extra", reason: "ajuste", ref: randomUUID(), note: String(req.body?.note ?? "").slice(0, 120) || undefined });
    return { ok: true, wallet };
  });
}
