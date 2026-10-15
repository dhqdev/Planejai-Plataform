import type { FastifyInstance } from "fastify";
import { scopeUserId } from "../../../accounts.js";
import { getSubscription, hasPlan, pricingOf, referralDiscount, withDiscount } from "../../../billing.js";
import { planById } from "../../../credits.js";
import { many, query } from "../../../db/pool.js";
import { getSettings } from "../../../settings.js";
import { withOutfits } from "../../../mascot.js";
import { myShares, selfUserId, setShare, sharedWithMe, type ShareScope } from "../../../sharing.js";
import { isUuid } from "./shared.js";
import { createInvite, createInviteCode, inviteLink, inviteStats, listContacts } from "../../../social.js";

/** Convites e contatos. */
export function inviteRoutes(base: FastifyInstance) {
  // ---------- Convites e contatos ----------
  base.get("/api/invites", async (req) => {
    const uid = scopeUserId(req.account);
    const isSuper = req.account.role === "superadmin";
    const rows = await many(
      `SELECT i.id, i.code, i.name, i.phone, i.email, i.status, i.sent_at, i.created_at, i.responded_at, i.expires_at,
              COALESCE(u.full_name, u.name, a.name, 'Equipe') AS inviter_name
         FROM invites i LEFT JOIN users u ON u.id = i.inviter_user_id LEFT JOIN accounts a ON a.id = i.inviter_account_id
        WHERE ($1::uuid IS NULL OR i.inviter_user_id = $1) ORDER BY i.created_at DESC LIMIT 300`,
      [uid],
    );
    const leaderboard = isSuper
      ? await many(
          `SELECT COALESCE(u.full_name, u.name, '+' || u.phone) AS name, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE i.status = 'accepted')::int AS accepted
             FROM invites i JOIN users u ON u.id = i.inviter_user_id GROUP BY 1 ORDER BY accepted DESC, total DESC LIMIT 20`,
        )
      : [];
    return { invites: rows.map((r) => ({ ...r, link: inviteLink(r.code) })), stats: await inviteStats(uid), leaderboard };
  });
  // Aba Convites de cada pessoa (dono incluso): só os convites e os amigos DELA e o desconto que eles dão
  base.get("/api/me/convites", async (req) => {
    const uid = await selfUserId(req.account);
    const s = await getSettings();
    const pricing = pricingOf(s);
    const empty = { linked: false, billing: pricing.enabled, discount: { friends: 0, percent: 0, step: 0, max: 0, next: null }, friends: [], invites: [], subscription: null };
    if (!uid) return empty;
    const [discount, sub, friends, invites] = await Promise.all([
      referralDiscount(uid, s),
      getSubscription(uid),
      // quem entrou pelo convite da pessoa; "paying" é a mesma regra do desconto (payingFriends)
      many(
        `SELECT u.id, COALESCE(u.full_name, u.name, 'Amigo') AS name, u.created_at AS joined_at, (s.status = 'active') AS paying
           FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
          WHERE u.invited_by = $1 AND u.id <> $1 AND u.status = 'active' ORDER BY u.created_at DESC LIMIT 200`,
        [uid],
      ),
      // convites que ainda não viraram cadastro (o aceito já aparece como amigo acima)
      many(
        `SELECT id, code, name, phone, status, created_at, expires_at FROM invites
          WHERE inviter_user_id = $1 AND status <> 'accepted' AND created_at > now() - interval '90 days' ORDER BY created_at DESC LIMIT 100`,
        [uid],
      ),
    ]);
    const plan = hasPlan(sub) ? planById(s, sub.plan_id) : null;
    return {
      linked: true,
      billing: pricing.enabled,
      discount: { ...discount, next: discount.step > 0 && discount.percent < discount.max ? Math.min(discount.max, discount.percent + discount.step) : null },
      // só o primeiro nome do amigo, como no Plano e grãos
      friends: await withOutfits(friends.map((f) => ({ id: f.id as string, name: String(f.name).split(" ")[0], joinedAt: f.joined_at, paying: Boolean(f.paying) }))),
      invites: invites.map((i) => ({ ...i, link: inviteLink(i.code) })),
      subscription: plan ? { plan: plan.name, price: plan.price, value: withDiscount(plan.price, discount.percent) } : null,
    };
  });
  base.post<{ Body: { name?: string; phone?: string; email?: string } }>("/api/invites", async (req, reply) => {
    const a = req.account;
    if (a.role !== "superadmin" && !a.userId) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil antes de convidar." });
    try {
      // sem telefone: convite por código (link de 24h, uso único) que a pessoa usa na landing
      if (!String(req.body?.phone ?? "").replace(/\D/g, "")) {
        const inv = await createInviteCode({ inviterUserId: await selfUserId(a), inviterAccountId: a.owner ? null : a.id, name: req.body?.name });
        return { ...inv, link: inviteLink(inv.code) };
      }
      const r = await createInvite({
        // convite do dono pelo painel também liga os dois como contatos (o WhatsApp dele vem de OWNER_PHONES)
        inviterUserId: await selfUserId(a),
        inviterAccountId: a.owner ? null : a.id,
        name: req.body.name,
        phone: String(req.body.phone ?? ""),
        email: req.body.email,
      });
      if ("already" in r) return reply.code(409).send({ error: "Essa pessoa já é seu contato." });
      return { ...r.invite, link: inviteLink(r.invite.code) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  base.delete<{ Params: { id: string } }>("/api/invites/:id", async (req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "não encontrado" });
    const r = await query("UPDATE invites SET status = 'expired' WHERE id = $1 AND status = 'pending' AND ($2::uuid IS NULL OR inviter_user_id = $2)", [
      req.params.id,
      scopeUserId(req.account),
    ]);
    return { ok: (r.rowCount ?? 0) > 0 };
  });
  base.get("/api/contacts", async (req) => {
    const uid = await selfUserId(req.account);
    return uid ? withOutfits(await listContacts(uid)) : [];
  });

  // ---------- Compartilhar Finanças/Agenda com um contato (cada tela é particular até a pessoa liberar) ----------
  base.get("/api/shares", async (req) => {
    const uid = await selfUserId(req.account);
    if (!uid) return { mine: [], withMe: [] };
    return { mine: await myShares(uid), withMe: await sharedWithMe(uid) };
  });
  base.put<{ Body: { contact?: string; scope?: ShareScope; on?: boolean } }>("/api/shares", async (req, reply) => {
    const uid = await selfUserId(req.account);
    if (!uid) return reply.code(400).send({ error: "Ligue seu WhatsApp ao perfil antes de compartilhar." });
    try {
      await setShare(uid, String(req.body?.contact ?? ""), req.body?.scope as ShareScope, Boolean(req.body?.on));
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
