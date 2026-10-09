import { decryptJson, encryptJson } from "./crypto.js";
import { many, one, query } from "./db/pool.js";
import { checkedUrl } from "./net.js";

/**
 * Lojas das compras pelo assistente: o catálogo pronto, as lojas que cada pessoa cadastra e o acesso salvo de cada uma
 * (e-mail e senha da loja, criptografados, digitados pelo servidor sem passar pelo modelo).
 */

export interface StoreDef {
  name: string;
  domains: string[];
  home: string;
  custom?: boolean;
}

export const STORES: Record<string, StoreDef> = {
  // sem mercadopago.com.br: a carteira do Mercado Pago não entra logada junto com a loja
  mercadolivre: { name: "Mercado Livre", domains: ["mercadolivre.com.br", "mercadolivre.com", "mercadolibre.com"], home: "https://www.mercadolivre.com.br/" },
  shopee: { name: "Shopee", domains: ["shopee.com.br"], home: "https://shopee.com.br/buyer/login" },
  amazon: { name: "Amazon", domains: ["amazon.com.br"], home: "https://www.amazon.com.br/" },
  magalu: { name: "Magalu", domains: ["magazineluiza.com.br", "magalu.com"], home: "https://www.magazineluiza.com.br/" },
  americanas: { name: "Americanas", domains: ["americanas.com.br"], home: "https://www.americanas.com.br/" },
  casasbahia: { name: "Casas Bahia", domains: ["casasbahia.com.br"], home: "https://www.casasbahia.com.br/" },
  pontofrio: { name: "Ponto", domains: ["pontofrio.com.br"], home: "https://www.pontofrio.com.br/" },
  extra: { name: "Extra", domains: ["extra.com.br"], home: "https://www.extra.com.br/" },
  submarino: { name: "Submarino", domains: ["submarino.com.br"], home: "https://www.submarino.com.br/" },
  kabum: { name: "KaBuM!", domains: ["kabum.com.br"], home: "https://www.kabum.com.br/" },
  fastshop: { name: "Fast Shop", domains: ["fastshop.com.br"], home: "https://www.fastshop.com.br/" },
  aliexpress: { name: "AliExpress", domains: ["aliexpress.com"], home: "https://pt.aliexpress.com/" },
  shein: { name: "Shein", domains: ["shein.com"], home: "https://br.shein.com/" },
  temu: { name: "Temu", domains: ["temu.com"], home: "https://www.temu.com/br" },
  netshoes: { name: "Netshoes", domains: ["netshoes.com.br"], home: "https://www.netshoes.com.br/" },
  centauro: { name: "Centauro", domains: ["centauro.com.br"], home: "https://www.centauro.com.br/" },
  decathlon: { name: "Decathlon", domains: ["decathlon.com.br"], home: "https://www.decathlon.com.br/" },
  nike: { name: "Nike", domains: ["nike.com.br"], home: "https://www.nike.com.br/" },
  dafiti: { name: "Dafiti", domains: ["dafiti.com.br"], home: "https://www.dafiti.com.br/" },
  zattini: { name: "Zattini", domains: ["zattini.com.br"], home: "https://www.zattini.com.br/" },
  renner: { name: "Renner", domains: ["lojasrenner.com.br"], home: "https://www.lojasrenner.com.br/" },
  cea: { name: "C&A", domains: ["cea.com.br"], home: "https://www.cea.com.br/" },
  riachuelo: { name: "Riachuelo", domains: ["riachuelo.com.br"], home: "https://www.riachuelo.com.br/" },
  carrefour: { name: "Carrefour", domains: ["carrefour.com.br"], home: "https://www.carrefour.com.br/" },
  leroymerlin: { name: "Leroy Merlin", domains: ["leroymerlin.com.br"], home: "https://www.leroymerlin.com.br/" },
  boticario: { name: "O Boticário", domains: ["boticario.com.br"], home: "https://www.boticario.com.br/" },
  natura: { name: "Natura", domains: ["natura.com.br"], home: "https://www.natura.com.br/" },
  sephora: { name: "Sephora", domains: ["sephora.com.br"], home: "https://www.sephora.com.br/" },
  drogasil: { name: "Drogasil", domains: ["drogasil.com.br"], home: "https://www.drogasil.com.br/" },
  drogaraia: { name: "Droga Raia", domains: ["drogaraia.com.br"], home: "https://www.drogaraia.com.br/" },
  petz: { name: "Petz", domains: ["petz.com.br"], home: "https://www.petz.com.br/" },
  cobasi: { name: "Cobasi", domains: ["cobasi.com.br"], home: "https://www.cobasi.com.br/" },
};

export const hostMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

const hostOf = (url: string | null | undefined) => {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const findIn = (defs: Record<string, StoreDef>, host: string | null) =>
  host ? (Object.entries(defs).find(([, s]) => s.domains.some((d) => hostMatches(host, d)))?.[0] ?? null) : null;

/** Loja do catálogo de uma URL ("mercadolivre"), ou null. */
export function storeOf(url: string | null | undefined): string | null {
  return findIn(STORES, hostOf(url));
}

// ---------------- Lojas que a pessoa cadastrou ----------------

export async function customStores(userId: string): Promise<Record<string, StoreDef>> {
  const rows = await many("SELECT id, name, domain, home FROM user_stores WHERE user_id = $1 ORDER BY created_at", [userId]);
  return Object.fromEntries(rows.map((r) => [r.id, { name: r.name, domains: [r.domain], home: r.home, custom: true }]));
}

/** Catálogo + lojas da pessoa. */
export async function storesOf(userId: string) {
  return { ...STORES, ...(await customStores(userId)) };
}

export async function storeDefFor(userId: string, id: string): Promise<StoreDef | null> {
  return STORES[id] ?? (await customStores(userId))[id] ?? null;
}

/** Loja de uma URL para essa pessoa: catálogo primeiro, depois as que ela cadastrou. */
export async function storeOfFor(userId: string, url: string | null | undefined) {
  const host = hostOf(url);
  return findIn(STORES, host) ?? findIn(await customStores(userId), host);
}

// sites que não são loja: e-mail, login e busca não podem virar "loja" para receber senha ou código
const NOT_STORES = ["google.com", "gmail.com", "googleapis.com", "youtube.com", "facebook.com", "instagram.com", "whatsapp.com", "apple.com", "microsoft.com", "live.com", "outlook.com", "yahoo.com"];
const MAX_CUSTOM = 20;
// "com.br" sozinho não é loja: casaria com todo site .com.br e a senha poderia ir para outro site
const SECOND_LEVEL = new Set(["com", "net", "org", "gov", "edu", "co", "ind", "art", "blog", "app", "shop", "ong", "eco", "tur", "emp", "log", "inf", "mil", "nom", "ac"]);
const isSuffix = (host: string) => {
  const parts = host.split(".");
  return parts.length < 2 || (parts.length === 2 && parts[1]!.length === 2 && SECOND_LEVEL.has(parts[0]!));
};

/** Cadastra uma loja pelo site. Loja do catálogo volta a do catálogo. */
export async function addCustomStore(userId: string, input: { name?: unknown; url?: unknown }) {
  const raw = String(input.url ?? "").trim();
  if (!raw) throw new Error("Mande o site da loja.");
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error("Endereço de loja inválido.");
  }
  if (url.protocol !== "https:") throw new Error("Use o endereço com https.");
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || isSuffix(host)) throw new Error("Endereço de loja inválido.");
  const known = findIn(STORES, host);
  if (known) return { id: known, ...STORES[known]! };
  if (NOT_STORES.some((d) => hostMatches(host, d))) throw new Error("Esse site não é uma loja.");
  // só site público (nada de rede interna): o navegador do servidor vai abrir esse endereço
  await checkedUrl(`https://${url.hostname}/`).catch(() => {
    throw new Error("Esse site não abre daqui. Confira o endereço.");
  });
  const name = String(input.name ?? "").trim().slice(0, 40) || host;
  const id = `u-${host.replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`;
  const count = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM user_stores WHERE user_id = $1", [userId]);
  if ((count?.n ?? 0) >= MAX_CUSTOM) throw new Error(`Dá para cadastrar até ${MAX_CUSTOM} lojas.`);
  const home = `https://${url.hostname}/`;
  await query(
    `INSERT INTO user_stores (user_id, id, name, domain, home) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, id) DO UPDATE SET name = $3`,
    [userId, id, name, host, home],
  );
  return { id, name, domains: [host], home, custom: true };
}

/** Tira a loja cadastrada, com o login e o acesso salvos dela. */
export async function removeCustomStore(userId: string, id: string) {
  if (!id.startsWith("u-")) throw new Error("Só dá para tirar loja que você cadastrou.");
  await query("DELETE FROM user_stores WHERE user_id = $1 AND id = $2", [userId, id]);
  await query("DELETE FROM store_sessions WHERE user_id = $1 AND store = $2", [userId, id]);
  await query("DELETE FROM store_logins WHERE user_id = $1 AND store = $2", [userId, id]);
}

// ---------------- Acesso salvo (e-mail e senha da loja) ----------------

export interface StoreAccess {
  email: string;
  password: string;
}

export async function saveStoreAccess(userId: string, store: string, input: { email?: unknown; password?: unknown }) {
  if (!(await storeDefFor(userId, store))) throw new Error("Loja não encontrada.");
  const email = String(input.email ?? "").trim().slice(0, 120);
  const password = String(input.password ?? "").slice(0, 200);
  const old = await storeAccess(userId, store);
  // senha em branco ao editar mantém a que já estava
  const next = { email: email || old?.email || "", password: password || old?.password || "" };
  if (!next.email && !next.password) throw new Error("Preencha o e-mail ou a senha.");
  await query(
    `INSERT INTO store_logins (user_id, store, data) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, store) DO UPDATE SET data = $3, updated_at = now()`,
    [userId, store, encryptJson(next)],
  );
  return { email: next.email, has_password: Boolean(next.password) };
}

export async function storeAccess(userId: string, store: string): Promise<StoreAccess | null> {
  const row = await one("SELECT data FROM store_logins WHERE user_id = $1 AND store = $2", [userId, store]);
  if (!row) return null;
  try {
    return decryptJson<StoreAccess>(row.data);
  } catch {
    return null;
  }
}

export async function clearStoreAccess(userId: string, store: string) {
  await query("DELETE FROM store_logins WHERE user_id = $1 AND store = $2", [userId, store]);
}

/**
 * Código de verificação num e-mail de loja ("Seu código é 482913"). Prefere o número perto de "código"/"code";
 * sem isso, um número de 6 dígitos sozinho. Nunca devolve ano, CEP ou preço por engano quando há um código rotulado.
 */
export function extractLoginCode(text: string): string | null {
  const t = text.replace(/\s+/g, " ");
  const labeled = t.match(/(?:c[óo]digo|code|verifica[çc][ãa]o|token|chave de acesso|senha tempor[áa]ria)[^0-9]{0,60}?\b(\d{4,8})\b/i);
  if (labeled) return labeled[1]!;
  const six = t.match(/(?<![\d,.])\b(\d{6})\b(?![\d,.])/);
  return six ? six[1]! : null;
}
