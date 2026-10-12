import { many, one, query } from "./db/pool.js";
import { isConnected } from "./integrations/registry.js";
import { anyVariant, conflicts, describe, mentions, norm, optionFits, parseQuery, parseWanted, pickerDim, type Dim, type Wanted } from "./variants.js";
import { cancelWatch, createWatch, updateWatch } from "./watches.js";

/**
 * Compras = achar o melhor preço. Nenhuma loja brasileira deixa um app de fora fechar a compra pela pessoa,
 * então o assistente busca nas APIs oficiais das lojas ao mesmo tempo (Mercado Livre, Shopee), compara e manda o link;
 * a pessoa compra no app da loja, logada, com o pagamento dela. Dinheiro nunca passa por nós.
 * Sem nenhuma loja conectada, a busca cai na pesquisa web (sem preço garantido).
 */

export interface Offer {
  store: "Mercado Livre" | "Shopee";
  title: string;
  cents: number;
  /** preço antes do desconto, quando a loja informa */
  old_cents?: number;
  link: string;
  image?: string;
  free_shipping?: boolean;
  seller?: string;
  rating?: number;
  sold?: number;
  /** o link já abre na variação pedida (tamanho, cor, voltagem, capacidade) */
  variant_ok?: boolean;
  /** o que a pessoa ainda escolhe na página da loja ("tamanho 42, preto") */
  pick?: string;
}

export interface SearchResult {
  offers: Offer[];
  /** lojas consultadas e as que falharam agora */
  stores: string[];
  failed: string[];
  /** sem loja conectada (ou nada achado): resultados da web para o agente ler */
  web?: { title: string; url: string; content?: string }[];
  web_answer?: string;
  /** custo da busca web pela IA (o runner tira daqui e põe na execução) */
  _usage?: unknown;
}

const toCents = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
};

/** Palavras que contam na busca: as curtas e as de ligação não dizem qual é o produto. */
const STOP = new Set(["para", "com", "sem", "uma", "um", "de", "do", "da", "dos", "das", "e", "o", "a", "os", "as", "mais", "barato", "barata", "melhor", "preco", "comprar"]);

/**
 * Ordenar só por preço traz capinha e cabo no topo ("fone JBL" acha "capa para fone JBL" por R$ 9).
 * Fica a oferta cujo título tem quase todas as palavras da busca e que não é acessório de quem não pediu acessório.
 */
export function relevant(queryText: string, title: string) {
  const words = norm(queryText)
    .trim()
    .split(" ")
    .filter((w) => w.length >= 2 && !STOP.has(w));
  if (!words.length) return true;
  const t = norm(title);
  const hits = words.filter((w) => t.includes(` ${w}`) || (w.length >= 4 && t.includes(w))).length;
  if (hits / words.length < (words.length <= 2 ? 1 : 0.6)) return false;
  const accessory = /\b(capa|capinha|case|pelicula|suporte|cabo|adaptador|protetor|almofada|espuma|refil|adesivo|skin|estojo|bolsa para)\b/;
  return accessory.test(norm(queryText)) || !accessory.test(` ${t.trim().split(" ").slice(0, 3).join(" ")} `);
}

async function fromMercadoLivre(q: string, limit: number, condition?: "new" | "used"): Promise<Offer[]> {
  const { mercadolivreSearch } = await import("./agent/tools/research.js");
  const r: any = await mercadolivreSearch.run({ query: q, limit, condition }, {} as any);
  if (r?.error) throw new Error(r.error);
  return (r?.items ?? [])
    .filter((i: any) => toCents(i.price) > 0)
    .map((i: any) => ({
      store: "Mercado Livre" as const,
      title: String(i.title ?? "").slice(0, 140),
      cents: toCents(i.price),
      old_cents: toCents(i.original_price) || undefined,
      link: i.link,
      image: typeof i.thumbnail === "string" ? i.thumbnail.replace(/^http:/, "https:") : undefined,
      free_shipping: Boolean(i.free_shipping),
      seller: i.official_store ?? i.seller ?? undefined,
    }));
}

async function fromShopee(q: string, limit: number): Promise<Offer[]> {
  const { shopeeSearch } = await import("./integrations/shopee.js");
  return (await shopeeSearch(q, limit))
    .filter((o) => toCents(o.priceMin) > 0 && o.offerLink)
    .map((o) => {
      const cents = toCents(o.priceMin);
      const rate = Number(o.priceDiscountRate ?? 0);
      return {
        store: "Shopee" as const,
        title: String(o.productName ?? "").slice(0, 140),
        cents,
        old_cents: rate > 0 && rate < 95 ? Math.round(cents / (1 - rate / 100)) : undefined,
        link: o.offerLink,
        image: o.imageUrl,
        seller: o.shopName,
        rating: Number(o.ratingStar) || undefined,
        sold: Number(o.sales) || undefined,
      };
    });
}

/** Até quantas ofertas do Mercado Livre trocam de link para a variação pedida (cada uma custa 1 a 4 chamadas). */
const RESOLVE_ML = 4;

/**
 * Leva a oferta do Mercado Livre para a variação pedida. No catálogo cada variação é um produto com id próprio
 * (/p/MLB…), e o produto lista os seletores (Cor, Tamanho, Voltagem…) com o id de cada opção: anda de um para o outro
 * até bater tudo o que dá. null = a loja não tem essa variação (a oferta sai da lista).
 */
async function resolveMercadoLivre(o: Offer, w: Wanted, condition?: "new" | "used"): Promise<Offer | null> {
  const dims = (Object.keys(w) as Dim[]).filter((d) => w[d]);
  const first = o.link.match(/\/p\/(MLB[A-Z0-9]+)/i)?.[1];
  if (!first) return { ...o, pick: describe(w) };
  const { mercadolivreApi } = await import("./integrations/mercadolivre.js");
  let id = first;
  let prod: any = await mercadolivreApi(`/products/${id}`);
  const done = new Set<Dim>();
  for (let hop = 0; hop < 6; hop++) {
    let moved = false;
    const missing: Dim[] = [];
    for (const d of dims) {
      if (done.has(d)) continue;
      const pickers: any[] = Array.isArray(prod?.pickers) ? prod.pickers : [];
      const picker = pickers.find((p) => {
        const opts: any[] = Array.isArray(p?.products) ? p.products : [];
        return pickerDim(String(p?.picker_name ?? p?.picker_id ?? ""), opts.map((x) => String(x?.picker_label ?? ""))) === d;
      });
      if (picker) {
        const opts: any[] = picker.products ?? [];
        const current = opts.find((x) => x?.product_id === id);
        if (current && optionFits(d, w[d]!, String(current.picker_label ?? ""))) {
          done.add(d);
          continue;
        }
        const opt = opts.find((x) => x?.product_id && optionFits(d, w[d]!, String(x.picker_label ?? "")));
        // os tamanhos podem depender da cor: tenta as outras escolhas antes de desistir desta
        if (!opt) {
          missing.push(d);
          continue;
        }
        id = String(opt.product_id);
        prod = await mercadolivreApi(`/products/${id}`);
        done.add(d);
        moved = true;
        break; // o produto novo tem seus próprios seletores
      }
      if (mentions(d, w[d]!, String(prod?.name ?? o.title))) done.add(d);
    }
    // a loja tem o seletor e a opção pedida não está nele: não vende nessa variação
    if (!moved && missing.length) return null;
    if (!moved) break;
  }
  const left = dims.filter((d) => !done.has(d));
  let next: Offer = { ...o, variant_ok: left.length === 0, pick: left.length ? describe(w, left) : undefined };
  if (id !== first) {
    // outra variação, outro preço: o menor anúncio ativo dela
    const items = await mercadolivreApi(`/products/${id}/items?limit=5`).catch(() => null);
    let list: any[] = items?.results ?? [];
    if (condition) list = list.filter((x) => x?.condition === condition);
    const best = list.filter((x) => toCents(x?.price) > 0).sort((a, b) => Number(a.price) - Number(b.price))[0];
    if (!best) return null;
    next = {
      ...next,
      title: String(prod?.name ?? o.title).slice(0, 140),
      cents: toCents(best.price),
      old_cents: toCents(best.original_price) || undefined,
      free_shipping: Boolean(best.shipping?.free_shipping),
      link: `https://www.mercadolivre.com.br/p/${id}`,
      image: typeof prod?.pictures?.[0]?.url === "string" ? prod.pictures[0].url.replace(/^http:/, "https:") : o.image,
    };
  }
  return next;
}

/** Preço muito abaixo dos outros do mesmo produto costuma ser golpe, peça avulsa ou anúncio errado. */
function dropSuspicious(offers: Offer[]) {
  if (offers.length < 4) return offers;
  const sorted = offers.map((o) => o.cents).sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const median = sorted.length % 2 ? sorted[Math.floor(mid)]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return offers.filter((o) => o.cents >= median * 0.3);
}

/**
 * Busca nas lojas conectadas ao mesmo tempo e devolve as ofertas que batem com o pedido, da mais barata para a mais cara.
 * `variant` ("42, preto", "220V", "128 GB"): tira o que diz outra variação e leva o link do Mercado Livre para a variação certa;
 * o que não der para garantir volta com `pick` (o que escolher na página da loja).
 */
export async function searchOffers(
  q: string,
  opts: { limit?: number; condition?: "new" | "used"; maxCents?: number; web?: "any" | "keys" | false; variant?: string | null } = {},
): Promise<SearchResult> {
  const text = q.trim().slice(0, 120);
  if (!text) throw new Error("Diga o que procurar");
  const limit = Math.max(1, Math.min(opts.limit ?? 8, 20));
  // a variação vem do texto da variação e do próprio pedido ("iphone 15 128gb"); "tanto faz" não pede nenhuma
  const fromVariant = anyVariant(opts.variant) ? {} : parseWanted(opts.variant, true);
  const wanted: Wanted = { ...parseQuery(text), ...fromVariant };
  const free = opts.variant?.trim() && !anyVariant(opts.variant) && !Object.keys(fromVariant).length ? opts.variant.trim().slice(0, 60) : null;
  // memória entra na busca (no catálogo cada capacidade é outro produto); tamanho, cor e voltagem não, senão some quem não escreve no título
  const searchText = wanted.capacity && !norm(text).includes(` ${wanted.capacity} `) ? `${text} ${describe({ capacity: wanted.capacity })}` : text;
  const sources: [string, () => Promise<Offer[]>][] = [];
  if (await isConnected("mercadolivre")) sources.push(["Mercado Livre", () => fromMercadoLivre(searchText, 8, opts.condition)]);
  if (await isConnected("shopee")) sources.push(["Shopee", () => fromShopee(searchText, 12)]);
  const settled = await Promise.allSettled(sources.map(([, f]) => f()));
  const failed: string[] = [];
  let offers: Offer[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") offers.push(...s.value);
    else failed.push(sources[i]![0]);
  });
  offers = offers.filter((o) => relevant(searchText, o.title) && !conflicts(wanted, o.title));
  // mesmo produto repetido (mesmo link) conta uma vez
  const seen = new Set<string>();
  offers = dropSuspicious(offers.filter((o) => (seen.has(o.link) ? false : (seen.add(o.link), true)))).sort((a, b) => a.cents - b.cents);
  if (Object.keys(wanted).length) {
    // as mais baratas do Mercado Livre vão para a variação certa; o resto (e a Shopee, que não expõe variações) diz o que escolher
    let budget = RESOLVE_ML;
    const head = offers.slice(0, limit + RESOLVE_ML);
    const resolved = await Promise.allSettled(
      head.map((o) => (o.store === "Mercado Livre" && budget-- > 0 ? resolveMercadoLivre(o, wanted, opts.condition) : Promise.resolve({ ...o, pick: describe(wanted) }))),
    );
    offers = resolved
      .map((r, i) => (r.status === "fulfilled" ? r.value : { ...head[i]!, pick: describe(wanted) }))
      .filter((o): o is Offer => Boolean(o))
      .filter((o) => !conflicts(wanted, o.title))
      .sort((a, b) => a.cents - b.cents);
  }
  if (free) offers = offers.map((o) => ({ ...o, pick: o.pick ? `${o.pick}, ${free}` : free }));
  offers = offers.filter((o) => !opts.maxCents || o.cents <= opts.maxCents).slice(0, limit);
  const out: SearchResult = { offers, stores: sources.map(([n]) => n), failed };
  // "keys": só busca com chave (Tavily/Brave), sem IA, para quem não passa pelo Tracer (painel)
  const web = opts.web ?? "any";
  if (!offers.length && web && (web === "any" || (await isConnected("tavily")) || (await isConnected("brave")))) {
    const { webSearch } = await import("./agent/tools/research.js");
    const variantWords = free ?? describe(wanted);
    const w: any = await webSearch.run({ query: `${text}${variantWords ? ` ${variantWords}` : ""} preço comprar`, max_results: 5 }, {} as any).catch(() => null);
    if (w?.results?.length) out.web = w.results.map((r: any) => ({ title: r.title, url: r.url, content: String(r.content ?? "").slice(0, 300) }));
    if (w?.answer) out.web_answer = String(w.answer).slice(0, 800);
    if (w?._usage) out._usage = w._usage;
  }
  return out;
}

// ---------- Lista de compras (o que a pessoa quer comprar, com aviso de preço opcional) ----------

export interface ItemInput {
  title: string;
  store?: string | null;
  cents?: number | null;
  link?: string | null;
  image?: string | null;
  query?: string | null;
  /** "42, preto", "220V": a variação que a pessoa quer */
  variant?: string | null;
}

const MAX_ITEMS = 60;

const cleanLink = (u?: string | null) => {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" ? url.toString().slice(0, 600) : null;
  } catch {
    return null;
  }
};

export async function listItems(userId: string) {
  return many(
    `SELECT i.id, i.title, i.store, i.cents, i.link, i.image, i.query, i.variant, i.bought_at, i.created_at,
            w.id AS watch_id, w.target AS alert_below, w.best AS watch_best, w.active AS watch_active, w.last_check_at
       FROM shopping_items i LEFT JOIN watches w ON w.id = i.watch_id
      WHERE i.user_id = $1 ORDER BY i.bought_at IS NOT NULL, i.created_at DESC LIMIT ${MAX_ITEMS}`,
    [userId],
  );
}

export async function addItem(userId: string, p: ItemInput) {
  const title = p.title?.trim().slice(0, 160);
  if (!title) throw new Error("Diga o nome do produto");
  const n = await one("SELECT COUNT(*)::int AS n FROM shopping_items WHERE user_id = $1 AND bought_at IS NULL", [userId]);
  if (n.n >= MAX_ITEMS) throw new Error(`A lista já tem ${n.n} itens; tire algum antes.`);
  const cents = p.cents != null && Number.isInteger(Number(p.cents)) && Number(p.cents) > 0 ? Number(p.cents) : null;
  return one(
    `INSERT INTO shopping_items (user_id, title, store, cents, link, image, query, variant) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, title, store, cents, link, image, query, variant, created_at`,
    [userId, title, p.store?.slice(0, 40) ?? null, cents, cleanLink(p.link), cleanLink(p.image), (p.query?.trim() || title).slice(0, 200), p.variant?.trim().slice(0, 60) || null],
  );
}

/** Aviso de preço do item: liga (com meta opcional, em centavos), ajusta a meta ou desliga. Usa os acompanhamentos. */
export async function setItemAlert(userId: string, id: string, conversationId: string, alert: { on: boolean; belowCents?: number | null }) {
  const item = await one("SELECT i.*, w.active AS watch_active FROM shopping_items i LEFT JOIN watches w ON w.id = i.watch_id WHERE i.id = $1 AND i.user_id = $2", [id, userId]);
  if (!item) return null;
  const target = alert.belowCents && alert.belowCents > 0 ? alert.belowCents / 100 : null;
  if (!alert.on) {
    if (item.watch_id) await cancelWatch(item.watch_id, userId);
    return { ok: true, alert: false };
  }
  if (item.watch_id && item.watch_active) {
    await updateWatch(item.watch_id, userId, { target, notify_mode: "changes" });
    return { ok: true, alert: true, watch_id: item.watch_id };
  }
  if (item.watch_id) {
    const w = await updateWatch(item.watch_id, userId, { target, notify_mode: "changes", reactivate: true, days: 30 });
    if (w) return { ok: true, alert: true, watch_id: item.watch_id };
  }
  const w = await createWatch({ userId, conversationId, kind: "price", query: item.query || item.title, variant: item.variant, target, days: 30, notifyMode: "changes" });
  await query("UPDATE shopping_items SET watch_id = $2 WHERE id = $1", [id, w.id]);
  return { ok: true, alert: true, watch_id: w.id };
}

export async function markBought(userId: string, id: string, bought: boolean) {
  const item = await one(
    "UPDATE shopping_items SET bought_at = CASE WHEN $3 THEN COALESCE(bought_at, now()) ELSE NULL END WHERE id = $1 AND user_id = $2 RETURNING *",
    [id, userId, bought],
  );
  // comprou: para de acompanhar o preço
  if (item && bought && item.watch_id) await cancelWatch(item.watch_id, userId);
  return item;
}

export async function removeItem(userId: string, id: string) {
  const item = await one("DELETE FROM shopping_items WHERE id = $1 AND user_id = $2 RETURNING watch_id", [id, userId]);
  if (item?.watch_id) await cancelWatch(item.watch_id, userId);
  return Boolean(item);
}

export async function findItems(userId: string, text: string) {
  return many(
    "SELECT id, title, store, cents, variant, watch_id, bought_at FROM shopping_items WHERE user_id = $1 AND title ILIKE '%' || $2 || '%' ORDER BY created_at DESC LIMIT 5",
    [userId, text.trim().slice(0, 80)],
  );
}
