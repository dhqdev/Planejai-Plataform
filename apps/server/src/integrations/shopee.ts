import { createHash } from "node:crypto";
import { getCredentials } from "./registry.js";

/**
 * Shopee Afiliados (Open API GraphQL do Brasil). Cada pedido é assinado com SHA256(AppId + Timestamp + corpo + Secret);
 * o corpo assinado tem que ser exatamente o enviado. A conta de afiliado pede acesso à API no painel de afiliados.
 */
const API = "https://open-api.affiliate.shopee.com.br/graphql";

export interface ShopeeOffer {
  itemId: number;
  shopId: number;
  productName: string;
  priceMin: string;
  priceMax: string;
  priceDiscountRate?: number;
  imageUrl?: string;
  offerLink: string;
  productLink?: string;
  shopName?: string;
  ratingStar?: string;
  sales?: number;
}

/** Texto como literal de string do GraphQL (o JSON escapa igual). */
const gqlString = (s: string) => JSON.stringify(s);

export async function shopeeGraphql(creds: { app_id?: string; secret?: string }, query: string) {
  if (!creds.app_id || !creds.secret) throw new Error("Shopee sem App ID ou Secret");
  const body = JSON.stringify({ query });
  const ts = Math.floor(Date.now() / 1000);
  const signature = createHash("sha256").update(`${creds.app_id}${ts}${body}${creds.secret}`).digest("hex");
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `SHA256 Credential=${creds.app_id}, Timestamp=${ts}, Signature=${signature}` },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.errors?.length) throw new Error(`Shopee: ${j.errors?.[0]?.message ?? res.status}`);
  return j.data;
}

const FIELDS = "itemId shopId productName priceMin priceMax priceDiscountRate imageUrl offerLink productLink shopName ratingStar sales";

/** Busca ofertas por palavra (por relevância; quem ordena por preço é a busca comparada). */
export async function shopeeSearch(keyword: string, limit = 10): Promise<ShopeeOffer[]> {
  const creds = await getCredentials("shopee");
  if (!creds) throw new Error("Shopee não está conectada");
  const n = Math.max(1, Math.min(limit, 20));
  const data = await shopeeGraphql(creds, `{ productOfferV2(keyword: ${gqlString(keyword.slice(0, 120))}, sortType: 1, page: 1, limit: ${n}) { nodes { ${FIELDS} } } }`);
  return data?.productOfferV2?.nodes ?? [];
}
