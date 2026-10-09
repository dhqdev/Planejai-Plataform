import { one } from "../../db/pool.js";
import { parsePixCode } from "../../pixcode.js";
import { approvePurchase, brl, buyerProfile, listPurchases, preparePurchase, purchaseRules, STATUS_TXT, updatePurchase } from "../../purchases.js";
import { getSettings } from "../../settings.js";
import { connectedStores } from "../../storelogin.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

export const purchaseInfo = defineTool<Record<string, never>>({
  name: "purchase_info",
  description:
    "Antes de comprar: lojas em que a pessoa conectou a conta (o navegador entra já logado), endereço de entrega dela e limites. " +
    "Chame uma vez no começo de cada compra.",
  parameters: obj({}),
  async run(_args, ctx) {
    const rules = purchaseRules(await getSettings());
    if (!rules.enabled) return { enabled: false, note: "Compras pelo assistente estão desligadas. Ajude só a achar o produto e mande o link." };
    const [profile, stores] = await Promise.all([buyerProfile(ctx.user.id), connectedStores(ctx.user.id)]);
    const a = profile.address;
    return {
      enabled: true,
      payment: "Pix direto: no checkout escolha Pix; a pessoa paga o código do banco dela depois do sim.",
      terms_accepted: profile.terms.accepted,
      stores: stores.map((x) => `${x.name} (${x.id}): ${x.connected ? "conta conectada" : "sem conta conectada"}`),
      delivery_address: a ? `${a.street}, ${a.number}${a.complement ? ` ${a.complement}` : ""}, ${a.district}, ${a.city}/${a.state}, CEP ${a.cep}` : "não cadastrado: use o endereço principal da conta da loja e diga qual é",
      limits: { per_purchase: brl(rules.maxCents), per_30_days: brl(rules.monthMaxCents) },
      ...(!profile.terms.accepted ? { missing: "Ela ainda não aceitou os Termos de compra: peça para abrir Compras no painel." } : {}),
    };
  },
});

export const purchaseStart = defineTool<{ title: string; url?: string; store?: string; pix_code: string; confirmed_by_user?: boolean }>({
  name: "purchase_start",
  description:
    "Fecha a compra depois que o carrinho está pronto no checkout e você escolheu Pix como pagamento na loja: passe o código Pix copia e cola INTEIRO que a loja gerou. " +
    "O servidor lê o valor exato do Pix, confere os limites e pergunta o sim à pessoa. Depois do sim, o sistema manda o código para ela pagar do banco dela. " +
    "Nunca invente valor: ele sai do código.",
  parameters: obj(
    {
      title: { type: "string", description: "o que está sendo comprado, curto (ex.: Fone JBL Tune 520BT preto)" },
      url: { type: "string", description: "link do produto ou do checkout" },
      store: { type: "string", description: "mercadolivre, shopee, amazon, magalu (se não tiver url)" },
      pix_code: { type: "string", description: "código Pix copia e cola gerado no checkout, inteiro" },
      ...CONFIRM_PARAM,
    },
    ["title", "pix_code"],
  ),
  async run(args, ctx) {
    if (ctx.approvedAction) {
      // a pessoa disse sim: executa a compra guardada com esse mesmo Pix (nada é recalculado pelo modelo)
      const payload = parsePixCode(args.pix_code)?.payload ?? "";
      const p = await one("SELECT id FROM purchases WHERE user_id = $1 AND store_pix = $2 AND status = 'awaiting_confirm' ORDER BY created_at DESC LIMIT 1", [ctx.user.id, payload]);
      if (!p) return { ok: false, error: "Esse pedido de compra expirou. Gere o Pix de novo no checkout se ela ainda quiser." };
      return approvePurchase(ctx.user.id, p.id);
    }
    let prepared;
    try {
      prepared = await preparePurchase(ctx.user.id, args);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    return requireConfirmation(args, prepared.summary, ctx);
  },
});

export const purchaseList = defineTool<{ limit?: number }>({
  name: "purchase_list",
  description: "Compras recentes da pessoa (loja, valor, situação, pedido e rastreio), com o id de cada uma.",
  parameters: obj({ limit: { type: "number" } }),
  async run(args, ctx) {
    const rows = await listPurchases(ctx.user.id, Math.min(Number(args.limit ?? 10) || 10, 30));
    return rows.map((r: any) => ({
      id: r.id,
      title: r.title,
      store: r.store,
      total: brl(Number(r.store_cents)),
      status: STATUS_TXT[r.status] ?? r.status,
      order: r.order_ref,
      tracking: r.tracking,
      when: r.created_at,
    }));
  },
});

export const purchaseUpdate = defineTool<{ id: string; order_ref?: string; tracking?: string; status?: "paid" | "delivered" | "canceled" }>({
  name: "purchase_update",
  description:
    "Anota o número do pedido ou o rastreio que você viu na loja, marca como pago quando a pessoa disser que pagou o Pix, entregue quando chegou, ou cancelado se ela desistiu.",
  parameters: obj(
    { id: { type: "string" }, order_ref: { type: "string" }, tracking: { type: "string" }, status: { type: "string", enum: ["paid", "delivered", "canceled"] } },
    ["id"],
  ),
  async run(args, ctx) {
    try {
      const p = await updatePurchase(ctx.user.id, args.id, args);
      return { ok: true, status: STATUS_TXT[p!.status] ?? p!.status };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
});
