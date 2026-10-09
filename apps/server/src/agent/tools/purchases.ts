import { one } from "../../db/pool.js";
import { parsePixCode } from "../../pixcode.js";
import { approvePurchase, brl, buyerProfile, listPurchases, preparePurchase, purchaseRules, STATUS_TXT, updatePurchase } from "../../purchases.js";
import { getSettings } from "../../settings.js";
import { connectedStores } from "../../storelogin.js";
import { extractLoginCode, storeAccess, storeDefFor, storeOfFor } from "../../stores.js";
import { googleApi } from "../../integrations/google.js";
import { bodyText, GMAIL } from "./communication.js";
import { snapshotText } from "./research.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

export const purchaseInfo = defineTool<Record<string, never>>({
  name: "purchase_info",
  description:
    "Antes de comprar: lojas em que a pessoa conectou a conta (o navegador entra já logado) ou salvou o acesso, endereço de entrega dela e limites. " +
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
      // só as lojas que ela usa: o catálogo inteiro custaria token à toa
      stores: stores
        .filter((x) => x.connected || x.access || x.custom)
        .map((x) => `${x.name} (${x.site}): ${[x.connected ? "logada" : "sem login", x.access ? "acesso salvo" : ""].filter(Boolean).join(", ")}`),
      delivery_address: a ? `${a.street}, ${a.number}${a.complement ? ` ${a.complement}` : ""}, ${a.district}, ${a.city}/${a.state}, CEP ${a.cep}` : "não cadastrado: use o endereço principal da conta da loja e diga qual é",
      limits: { per_purchase: brl(rules.maxCents), per_30_days: brl(rules.monthMaxCents) },
      ...(!profile.terms.accepted ? { missing: "Ela ainda não aceitou os Termos de compra: peça para abrir Compras no painel." } : {}),
    };
  },
});

export const purchaseStart = defineTool<{ title: string; pix_code: string; confirmed_by_user?: boolean }>({
  name: "purchase_start",
  description:
    "Fecha a compra com o navegador ainda aberto na página de pagamento da loja, depois de escolher Pix: passe o código de pix_codes INTEIRO que a loja gerou. " +
    "O servidor lê o valor exato do Pix, confere os limites e pergunta o sim à pessoa. Depois do sim, o sistema manda o código para ela pagar do banco dela. " +
    "Nunca invente valor: ele sai do código.",
  parameters: obj(
    {
      title: { type: "string", description: "o que está sendo comprado, curto (ex.: Fone JBL Tune 520BT preto)" },
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
    // o Pix tem que estar na página da loja aberta agora: código vindo de outro lugar (anúncio, mensagem, outro site) não vale
    const b = ctx.room.browser;
    if (!b) return { ok: false, error: "Abra o checkout da loja com browser_open e gere o Pix lá antes." };
    const pageUrl = b.page.url();
    const store = await storeOfFor(ctx.user.id, pageUrl);
    if (!store) return { ok: false, error: "A página aberta não é de uma loja da pessoa. O Pix só vale gerado no checkout da loja." };
    const want = parsePixCode(args.pix_code)?.payload;
    const onPage = ((await b.snapshot()).pix ?? []).map((c) => parsePixCode(c)?.payload);
    if (!want || !onPage.includes(want)) return { ok: false, error: "Esse código não está na página de pagamento aberta. Use o código de pix_codes dessa página." };
    let prepared;
    try {
      prepared = await preparePurchase(ctx.user.id, { title: args.title, url: pageUrl, store, pix_code: want });
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

/** Loja da página aberta agora, se for uma loja (do catálogo ou cadastrada) da pessoa. */
async function storeOnPage(ctx: Parameters<typeof purchaseInfo.run>[1]) {
  const b = ctx.room.browser;
  if (!b) return { error: "Abra a loja primeiro com browser_open." } as const;
  const store = await storeOfFor(ctx.user.id, b.page.url());
  if (!store) return { error: "A página aberta não é de uma loja da pessoa. Senha e código só são digitados no site da própria loja." } as const;
  return { b, store } as const;
}

export const storeLoginFill = defineTool<{ ref: number; field: "email" | "password" }>({
  name: "store_login_fill",
  description:
    "Login vencido na loja: digita no campo (ref) o e-mail ou a senha que a pessoa salvou para essa loja. O sistema digita, você não vê o valor. " +
    "Só funciona no site da própria loja. Sem acesso salvo, devolva ao CTO que ela precisa entrar de novo em Compras no painel.",
  parameters: obj(
    { ref: { type: "number", description: "número do campo na última lista" }, field: { type: "string", enum: ["email", "password"] } },
    ["ref", "field"],
  ),
  async run(args, ctx) {
    const on = await storeOnPage(ctx);
    if ("error" in on) return { ok: false, error: on.error };
    const access = await storeAccess(ctx.user.id, on.store);
    const value = args.field === "password" ? access?.password : access?.email;
    if (!value) return { ok: false, error: `A pessoa não salvou ${args.field === "password" ? "a senha" : "o e-mail"} dessa loja. Peça para ela entrar de novo em Compras no painel.` };
    try {
      await on.b.fillSecret(Number(args.ref), value, args.field === "password" ? "a senha da loja" : "o e-mail da loja", args.field);
    } catch (err) {
      return { ok: false, error: `${(err as Error).message} Veja a lista de novo.` };
    }
    on.b.store = on.store;
    on.b.saveLogin = true;
    on.b.lockedTo = (await storeDefFor(ctx.user.id, on.store))?.domains ?? null;
    return { ok: true, ...snapshotText(await on.b.snapshot()) };
  },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const storeLoginCode = defineTool<{ ref: number }>({
  name: "store_login_code",
  description:
    "A loja mandou um código de verificação para o e-mail da pessoa: o sistema procura o código no Gmail dela (só e-mails da loja, recentes) e digita no campo (ref). " +
    "Você não vê o código. Peça o código à loja antes (clique em enviar código por e-mail) e chame logo depois.",
  integration: "google",
  parameters: obj({ ref: { type: "number", description: "número do campo do código na última lista" } }, ["ref"]),
  async run(args, ctx) {
    const on = await storeOnPage(ctx);
    if ("error" in on) return { ok: false, error: on.error };
    const def = await storeDefFor(ctx.user.id, on.store);
    const from = (def?.domains ?? []).map((d) => `from:${d}`).join(" OR ");
    const since = on.b.openedAt - 60_000;
    let code: string | null = null;
    // o e-mail pode levar alguns segundos para chegar
    for (let i = 0; i < 4 && !code; i++) {
      if (i) await sleep(10_000);
      const list = await googleApi(`${GMAIL}/messages?q=${encodeURIComponent(`(${from}) newer_than:1d`)}&maxResults=3`);
      for (const m of list.messages ?? []) {
        const full = await googleApi(`${GMAIL}/messages/${m.id}?format=full`);
        if (Number(full.internalDate ?? 0) < since) continue;
        const subject = full.payload?.headers?.find((h: any) => h.name.toLowerCase() === "subject")?.value ?? "";
        code = extractLoginCode(`${subject}\n${bodyText(full.payload)}`);
        if (code) break;
      }
    }
    if (!code) return { ok: false, error: `Nenhum código de ${def?.name ?? "da loja"} chegou no Gmail dela. Confira se a loja mandou para o e-mail (e não por SMS); se for SMS, peça para ela entrar em Compras no painel.` };
    try {
      await on.b.fillSecret(Number(args.ref), code, "o código do e-mail", "code");
    } catch (err) {
      return { ok: false, error: `${(err as Error).message} Veja a lista de novo.` };
    }
    on.b.store = on.store;
    on.b.saveLogin = true;
    on.b.lockedTo = (await storeDefFor(ctx.user.id, on.store))?.domains ?? null;
    return { ok: true, ...snapshotText(await on.b.snapshot()) };
  },
});
