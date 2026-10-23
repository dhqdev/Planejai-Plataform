import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  asaasMode,
  billingAccess,
  billingOverview,
  buyPack,
  cancelSubscription,
  changePlan,
  forgetCard,
  getSubscription,
  hasPlan,
  paymentsOf,
  pricingOf,
  referralDiscount,
  savedCardOf,
  subscribe,
  withDiscount,
} from "../../../billing.js";
import { CheckoutError, cardCharge, cardRefusal, checkoutCard, checkoutItem, payerOf } from "../../../checkout.js";
import { config } from "../../../config.js";
import { creditGrains, dailyBurn, ensureWallet, grainsExempt, hasPaid, ledgerOf, planById } from "../../../credits.js";
import { many, one, query } from "../../../db/pool.js";
import { isConnected } from "../../../integrations/registry.js";
import { payToken } from "../../../paylink.js";
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
    const [wallet, ledger, burn, sub, access, referral, paid] = await Promise.all([
      ensureWallet(user.id, s),
      ledgerOf(user.id, 30),
      dailyBurn(user.id),
      getSubscription(user.id),
      billingAccess(user, s),
      referralDiscount(user.id, s),
      hasPaid(user.id),
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
      // já tem cadastro no Asaas: não precisa pedir nome e CPF de novo
      hasCustomer: Boolean(sub?.asaas_customer_id),
      name: user.full_name ?? user.name ?? "",
      email: user.email ?? req.account.email ?? "",
      wallet,
      burnPerDay: Math.round(burn),
      access: { allowed: access.allowed, state: access.state, until: access.state === "trial" ? access.until : null },
      // já pagou alguma vez: o menu mostra a aba Pagamentos
      paid,
      ledger,
      // cartão que já pagou: pacote sai com um toque, sem abrir a página do Asaas
      savedCard: savedCardOf(sub),
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

  // aba Pagamentos: cobranças da pessoa no Asaas (só de quem já pagou alguma vez)
  base.get("/api/billing/payments", async (req, reply) => {
    const user = await me(req);
    if (!user) return { payments: [] };
    try {
      return { payments: await paymentsOf(user.id) };
    } catch (err) {
      return fail(reply, err);
    }
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

  base.post<{ Body: { packId?: string; name?: string; cpfCnpj?: string; email?: string; savedCard?: boolean } }>("/api/billing/pack", async (req, reply) => {
    const user = await me(req);
    if (!user) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil antes de comprar." });
    try {
      const p = await buyPack(user, String(req.body?.packId ?? ""), {
        name: req.body?.name,
        cpfCnpj: req.body?.cpfCnpj,
        email: req.body?.email ?? user.email ?? req.account.email,
        savedCard: req.body?.savedCard === true,
        remoteIp: req.ip,
      });
      return { ok: true, paid: p.status === "paid", invoiceUrl: p.invoice_url, value: Number(p.value), grains: Number(p.grains) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // checkout próprio (pages/Checkout.tsx): o que está sendo comprado e quem precisa preencher nome e CPF
  base.get<{ Querystring: { kind?: string; id?: string } }>("/api/checkout/item", async (req, reply) => {
    const user = await me(req);
    if (!user) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil antes de assinar." });
    try {
      const s = await getSettings();
      const kind = req.query.kind === "plan" ? "plan" : "pack";
      const [sub, referral] = await Promise.all([getSubscription(user.id), referralDiscount(user.id, s)]);
      if (kind === "plan" && hasPlan(sub) && (sub.last_payment_at || sub.status === "active")) return reply.code(409).send({ error: "Você já tem um plano. Para trocar, use Meu plano." });
      const item = await checkoutItem(kind, String(req.query.id ?? ""), kind === "plan" ? referral.percent : 0);
      return {
        ...item,
        ready: await isConnected("asaas"),
        needsDoc: !sub?.asaas_customer_id,
        name: user.full_name ?? user.name ?? "",
        email: user.email ?? req.account.email ?? "",
        // pacote com o cartão que já pagou: um toque
        savedCard: kind === "pack" ? savedCardOf(sub) : null,
      };
    } catch (err) {
      if (err instanceof CheckoutError) return reply.code(err.status).send({ error: err.message });
      return fail(reply, err);
    }
  });

  /**
   * Começa o pagamento no checkout. Pix ou boleto: cria a cobrança (assinatura ou pacote) e devolve o token dela, que a
   * tela usa para mostrar o QR ou o boleto. Cartão: plano assina já no cartão (renova sozinho); pacote cobra na hora.
   */
  base.post<{ Body: { kind?: string; id?: string; method?: string; name?: string; cpfCnpj?: string; card?: Record<string, string>; savedCard?: boolean } }>(
    "/api/checkout/start",
    async (req, reply) => {
      const user = await me(req);
      if (!user) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil antes de assinar." });
      const b = req.body ?? {};
      const id = String(b.id ?? "");
      const email = user.email ?? req.account.email;
      const card = b.method === "card";
      try {
        if (b.kind === "plan") {
          const charge = card ? cardCharge({ ...b.card, email: b.card?.email || email }, { email, phone: user.phone }, req.ip) : undefined;
          const sub = await subscribe(user, { planId: id, method: card ? "card" : "pix", name: b.name, cpfCnpj: b.cpfCnpj, email, card: charge }).catch((err: Error) => {
            throw card && !(err instanceof CheckoutError) && !/nome completo|CPF ou CNPJ|já tem um plano|não encontrado|não está ligada/i.test(err.message) ? new CheckoutError(cardRefusal(err)) : err;
          });
          return { ok: true, paid: sub.paid, token: sub.payment_id ? payToken(sub.payment_id) : null };
        }
        if (b.savedCard) {
          const p = await buyPack(user, id, { savedCard: true, remoteIp: req.ip });
          return { ok: true, paid: p.status === "paid", token: p.asaas_payment_id ? payToken(p.asaas_payment_id) : null };
        }
        // cartão de pacote: confere o cartão antes de criar a cobrança, para erro de digitação não deixar cobrança aberta
        if (card) cardCharge({ ...b.card, email: b.card?.email || email }, (await payerOf(user.id)) ?? {}, req.ip);
        const p = await buyPack(user, id, { name: b.name, cpfCnpj: b.cpfCnpj, email });
        if (!p.asaas_payment_id) return reply.code(400).send({ error: "O Asaas não criou a cobrança. Tente de novo." });
        const token = payToken(p.asaas_payment_id);
        if (!card) return { ok: true, paid: false, token };
        const r = await checkoutCard(token, { ...b.card, email: b.card?.email || email }, req.ip);
        return { ok: true, paid: r.paid, token };
      } catch (err) {
        if (err instanceof CheckoutError) return reply.code(err.status).send({ error: err.message });
        return fail(reply, err);
      }
    },
  );

  base.delete("/api/billing/card", async (req, reply) => {
    const uid = req.account.userId;
    if (!uid) return reply.code(400).send({ error: "Sem cartão nesta conta." });
    await forgetCard(uid);
    return { ok: true };
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
