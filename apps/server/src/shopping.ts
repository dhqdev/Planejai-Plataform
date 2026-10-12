import { many, one, query } from "./db/pool.js";
import { isConnected } from "./integrations/registry.js";
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

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ");

/** Palavras que contam na busca: as curtas e as de ligação não dizem qual é o produto. */
const STOP = new Set(["para", "com", "sem", "uma", "um", "de", "do", "da", "dos", "das", "e", "o", "a", "os", "as", "mais", "barato", "barata", "melhor", "preco", "comprar"]);

/**
 * Ordenar só por preço traz capinha e cabo no topo ("fone JBL" acha "capa para fone JBL" por R$ 9).
 * Fica a oferta cujo título tem quase todas as palavras da busca e que não é acessório de quem não pediu acessório.
 */
export function relevant(queryText: string, title: string) {
  const words = norm(queryText)
    .split(" ")
    .filter((w) => w.length >= 2 && !STOP.has(w));
  if (!words.length) return true;
  const t = ` ${norm(title)} `;
  const hits = words.filter((w) => t.includes(` ${w}`) || (w.length >= 4 && t.includes(w))).length;
  if (hits / words.length < (words.length <= 2 ? 1 : 0.6)) return false;
  const accessory = /\b(capa|capinha|case|pelicula|suporte|cabo|adaptador|protetor|almofada|espuma|refil|adesivo|skin|estojo|bolsa para)\b/;
  return accessory.test(norm(queryText)) || !accessory.test(` ${norm(title).split(" ").slice(0, 3).join(" ")} `);
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

/** Busca nas lojas conectadas ao mesmo tempo e devolve as ofertas que batem com o pedido, da mais barata para a mais cara. */
export async function searchOffers(
  q: string,
  opts: { limit?: number; condition?: "new" | "used"; maxCents?: number; web?: "any" | "keys" | false } = {},
): Promise<SearchResult> {
  const text = q.trim().slice(0, 120);
  if (!text) throw new Error("Diga o que procurar");
  const limit = Math.max(1, Math.min(opts.limit ?? 8, 20));
  const sources: [string, () => Promise<Offer[]>][] = [];
  if (await isConnected("mercadolivre")) sources.push(["Mercado Livre", () => fromMercadoLivre(text, 8, opts.condition)]);
  if (await isConnected("shopee")) sources.push(["Shopee", () => fromShopee(text, 12)]);
  const settled = await Promise.allSettled(sources.map(([, f]) => f()));
  const failed: string[] = [];
  let offers: Offer[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") offers.push(...s.value);
    else failed.push(sources[i]![0]);
  });
  offers = offers.filter((o) => relevant(text, o.title) && (!opts.maxCents || o.cents <= opts.maxCents));
  // mesmo produto repetido (mesmo link) conta uma vez
  const seen = new Set<string>();
  offers = offers.filter((o) => (seen.has(o.link) ? false : (seen.add(o.link), true))).sort((a, b) => a.cents - b.cents).slice(0, limit);
  const out: SearchResult = { offers, stores: sources.map(([n]) => n), failed };
  // "keys": só busca com chave (Tavily/Brave), sem IA, para quem não passa pelo Tracer (painel)
  const web = opts.web ?? "any";
  if (!offers.length && web && (web === "any" || (await isConnected("tavily")) || (await isConnected("brave")))) {
    const { webSearch } = await import("./agent/tools/research.js");
    const w: any = await webSearch.run({ query: `${text} preço comprar`, max_results: 5 }, {} as any).catch(() => null);
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
    `SELECT i.id, i.title, i.store, i.cents, i.link, i.image, i.query, i.bought_at, i.created_at,
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
    `INSERT INTO shopping_items (user_id, title, store, cents, link, image, query) VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, title, store, cents, link, image, query, created_at`,
    [userId, title, p.store?.slice(0, 40) ?? null, cents, cleanLink(p.link), cleanLink(p.image), (p.query?.trim() || title).slice(0, 200)],
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
  const w = await createWatch({ userId, conversationId, kind: "price", query: item.query || item.title, target, days: 30, notifyMode: "changes" });
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
    "SELECT id, title, store, cents, watch_id, bought_at FROM shopping_items WHERE user_id = $1 AND title ILIKE '%' || $2 || '%' ORDER BY created_at DESC LIMIT 5",
    [userId, text.trim().slice(0, 80)],
  );
}
