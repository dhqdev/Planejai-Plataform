import { addItem, findItems, listItems, markBought, removeItem, searchOffers, setItemAlert } from "../../shopping.js";
import { brl } from "./finance.js";
import { defineTool, obj } from "./types.js";

const money = (cents: number) => brl(cents / 100);

export const shopSearch = defineTool<{ query: string; condition?: "new" | "used"; max_price?: number }>({
  name: "shop_search",
  description:
    "Acha o menor preço de um produto nas lojas (Mercado Livre e Shopee ao mesmo tempo), já filtrando acessório e o que não bate com o pedido. " +
    "Volta as ofertas da mais barata para a mais cara, com loja, preço formatado e link. Sem loja conectada, volta resultados da web.",
  parameters: obj(
    {
      query: { type: "string", description: "Produto com marca e modelo, sem 'barato' nem 'comprar' (ex.: 'fone JBL Tune 520BT')" },
      condition: { type: "string", enum: ["new", "used"] },
      max_price: { type: "number", description: "Teto em reais, se a pessoa disse" },
    },
    ["query"],
  ),
  async run(args) {
    const r = await searchOffers(args.query, {
      limit: 5,
      condition: args.condition,
      maxCents: args.max_price ? Math.round(args.max_price * 100) : undefined,
    });
    return {
      offers: r.offers.map((o) => ({
        store: o.store,
        title: o.title.slice(0, 90),
        price: money(o.cents),
        cents: o.cents,
        ...(o.old_cents && o.old_cents > o.cents ? { before: money(o.old_cents) } : {}),
        ...(o.free_shipping ? { free_shipping: true } : {}),
        link: o.link,
      })),
      stores: r.stores,
      ...(r.failed.length ? { failed: r.failed } : {}),
      ...(r.web ? { web: r.web, note: "Sem preço das lojas: resultados da web, confira o preço na página antes de citar." } : {}),
      ...(r.web_answer ? { web_answer: r.web_answer } : {}),
      ...(r._usage ? { _usage: r._usage } : {}),
    };
  },
});

export const shopSave = defineTool<{ title: string; store?: string; cents?: number; link?: string; alert?: boolean; alert_below?: number }>({
  name: "shop_save",
  description:
    "Guarda um produto na lista de compras da pessoa (aparece em Compras no painel). alert=true fica de olho no preço por 30 dias e avisa quando baixar; " +
    "alert_below (reais) avisa quando chegar nesse valor.",
  parameters: obj(
    {
      title: { type: "string" },
      store: { type: "string" },
      cents: { type: "number", description: "Preço em centavos, o de shop_search" },
      link: { type: "string" },
      alert: { type: "boolean" },
      alert_below: { type: "number" },
    },
    ["title"],
  ),
  async run(args, ctx) {
    const item = await addItem(ctx.user.id, { title: args.title, store: args.store, cents: args.cents, link: args.link });
    const wantsAlert = Boolean(args.alert || args.alert_below);
    if (wantsAlert) await setItemAlert(ctx.user.id, item.id, ctx.conversation.id, { on: true, belowCents: args.alert_below ? Math.round(args.alert_below * 100) : null });
    return { ok: true, id: item.id, alert: wantsAlert, note: wantsAlert ? "Fico de olho no preço por 30 dias e aviso quando baixar." : "Está na lista em Compras." };
  },
});

export const shopList = defineTool<{ text?: string }>({
  name: "shop_list",
  description: "Lista de compras da pessoa (o que falta comprar, com preço salvo e se tem aviso de preço). text filtra pelo nome.",
  parameters: obj({ text: { type: "string" } }),
  async run(args, ctx) {
    const rows = args.text?.trim() ? await findItems(ctx.user.id, args.text) : (await listItems(ctx.user.id)).filter((r) => !r.bought_at).slice(0, 15);
    return {
      items: rows.map((r: any) => ({
        id: r.id,
        title: r.title,
        ...(r.store ? { store: r.store } : {}),
        ...(r.cents ? { price: money(r.cents) } : {}),
        ...(r.watch_id ? { alert: true } : {}),
        ...(r.bought_at ? { bought: true } : {}),
      })),
    };
  },
});

export const shopUpdate = defineTool<{ id: string; bought?: boolean; alert?: boolean; alert_below?: number; remove?: boolean }>({
  name: "shop_update",
  description: "Mexe num item da lista (id de shop_list): bought=true (comprou, para de vigiar o preço), alert liga/desliga o aviso de preço, alert_below muda a meta, remove tira da lista.",
  parameters: obj(
    { id: { type: "string" }, bought: { type: "boolean" }, alert: { type: "boolean" }, alert_below: { type: "number" }, remove: { type: "boolean" } },
    ["id"],
  ),
  async run(args, ctx) {
    if (args.remove) return { ok: await removeItem(ctx.user.id, args.id) };
    if (args.bought !== undefined && !(await markBought(ctx.user.id, args.id, args.bought))) return { error: "Item não encontrado" };
    if (args.alert !== undefined || args.alert_below !== undefined) {
      const r = await setItemAlert(ctx.user.id, args.id, ctx.conversation.id, {
        on: args.alert ?? true,
        belowCents: args.alert_below ? Math.round(args.alert_below * 100) : null,
      });
      if (!r) return { error: "Item não encontrado" };
    }
    return { ok: true };
  },
});
