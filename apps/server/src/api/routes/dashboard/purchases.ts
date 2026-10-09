import type { FastifyInstance } from "fastify";
import { acceptPurchaseTerms, buyerProfile, listPurchases, purchaseRules, purchasesOverview, saveBuyerAddress, updatePurchase } from "../../../purchases.js";
import { getSettings } from "../../../settings.js";
import { selfUserId } from "../../../sharing.js";
import { addCustomStore, clearStoreAccess, removeCustomStore, saveStoreAccess, storeDefFor } from "../../../stores.js";
import { cancelStoreLogin, connectedStores, disconnectStore, finishStoreLogin, loginFrame, loginInput, startStoreLogin } from "../../../storelogin.js";
import { isUuid } from "./shared.js";

const fail = (reply: any, err: unknown) => reply.code(400).send({ error: (err as Error).message });

/** Compras pelo assistente de quem está logado: endereço de entrega, termos, lojas conectadas e histórico. */
export function purchaseRoutes(base: FastifyInstance) {
  const uidOf = async (req: any, reply: any) => {
    const uid = await selfUserId(req.account);
    if (!uid) reply.code(400).send({ error: "Conta sem WhatsApp ligado" });
    return uid;
  };

  base.get("/api/compras", async (req, reply) => {
    const uid = await uidOf(req, reply);
    if (!uid) return;
    const rules = purchaseRules(await getSettings());
    const [profile, stores, purchases] = await Promise.all([buyerProfile(uid), connectedStores(uid), listPurchases(uid)]);
    return { rules, profile, stores, purchases };
  });

  base.put<{ Body: { address?: unknown } }>("/api/compras/endereco", async (req, reply) => {
    const uid = await uidOf(req, reply);
    if (!uid) return;
    try {
      return await saveBuyerAddress(uid, req.body?.address);
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.post("/api/compras/termos", async (req, reply) => {
    const uid = await uidOf(req, reply);
    if (!uid) return;
    return acceptPurchaseTerms(uid, req.ip);
  });

  base.patch<{ Params: { id: string }; Body: { status?: "paid" | "delivered" | "canceled" } }>("/api/compras/:id", async (req, reply) => {
    const uid = await uidOf(req, reply);
    if (!uid) return;
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "Compra não encontrada." });
    try {
      return await updatePurchase(uid, req.params.id, { status: req.body?.status });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ---------- Lojas que a pessoa cadastra e acesso salvo (e-mail e senha, criptografados) ----------
  base.post<{ Body: { name?: string; url?: string } }>("/api/compras/lojas", async (req, reply) => {
    const uid = await uidOf(req, reply);
    if (!uid) return;
    try {
      return await addCustomStore(uid, req.body ?? {});
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.delete<{ Params: { store: string } }>("/api/compras/lojas/:store/cadastro", async (req, reply) => {
    const uid = await uidOf(req, reply);
    if (!uid) return;
    try {
      await removeCustomStore(uid, req.params.store);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.put<{ Params: { store: string }; Body: { email?: string; password?: string } }>("/api/compras/lojas/:store/acesso", async (req, reply) => {
    const uid = await uidOf(req, reply);
    if (!uid) return;
    try {
      return await saveStoreAccess(uid, req.params.store, req.body ?? {});
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.delete<{ Params: { store: string } }>("/api/compras/lojas/:store/acesso", async (req, reply) => {
    const uid = await uidOf(req, reply);
    if (!uid) return;
    await clearStoreAccess(uid, req.params.store);
    return { ok: true };
  });

  // ---------- Conta da pessoa na loja: login feito por ela numa janela ao vivo ----------
  base.post<{ Params: { store: string }; Body: { device?: string } }>("/api/compras/lojas/:store/login", async (req, reply) => {
    const uid = await uidOf(req, reply);
    if (!uid) return;
    if (!(await storeDefFor(uid, req.params.store))) return reply.code(404).send({ error: "Loja não encontrada." });
    try {
      return await startStoreLogin(uid, req.params.store, req.body?.device === "mobile" ? "mobile" : "desktop");
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.get<{ Params: { id: string } }>("/api/compras/login/:id/tela", async (req, reply) => {
    const uid = await uidOf(req, reply);
    if (!uid) return;
    try {
      const img = await loginFrame(req.params.id, uid);
      return reply.header("Cache-Control", "no-store").type("image/jpeg").send(img);
    } catch (err) {
      return reply.code(410).send({ error: (err as Error).message });
    }
  });

  base.post<{ Params: { id: string }; Body: any }>("/api/compras/login/:id", async (req, reply) => {
    const uid = await uidOf(req, reply);
    if (!uid) return;
    try {
      return await loginInput(req.params.id, uid, req.body as any);
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.post<{ Params: { id: string } }>("/api/compras/login/:id/pronto", async (req, reply) => {
    const uid = await uidOf(req, reply);
    if (!uid) return;
    try {
      return await finishStoreLogin(req.params.id, uid);
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.delete<{ Params: { id: string } }>("/api/compras/login/:id", async (req, reply) => {
    const uid = await uidOf(req, reply);
    if (!uid) return;
    await cancelStoreLogin(req.params.id, uid);
    return { ok: true };
  });

  base.delete<{ Params: { store: string } }>("/api/compras/lojas/:store", async (req, reply) => {
    const uid = await uidOf(req, reply);
    if (!uid) return;
    await disconnectStore(uid, req.params.store);
    return { ok: true };
  });
}

/** Visão do dono: quantas compras o assistente fechou no mês (só números). */
export function purchaseAdminRoutes(api: FastifyInstance) {
  api.get("/api/compras/admin", async () => ({ month: await purchasesOverview(), rules: purchaseRules(await getSettings()) }));
}
