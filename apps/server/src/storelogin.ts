import { randomUUID } from "node:crypto";
import { BrowserSession, type StoredCookie } from "./agent/browser.js";
import { decryptJson, encryptJson } from "./crypto.js";
import { many, one, query } from "./db/pool.js";
import { storeDefFor, storeOfFor, storesOf } from "./stores.js";

/**
 * Login da pessoa na conta dela de uma loja, feito por ELA no painel: o servidor abre um navegador na página da loja,
 * o painel mostra a tela (um print a cada instante) e manda os cliques e o que ela digita. Senha e código chegam direto
 * no navegador, nunca passam pelo modelo. No fim guardamos só os cookies do login, criptografados, para o agente
 * entrar já logado na hora de comprar. Ela pode desconectar quando quiser.
 */

const IDLE_MS = 5 * 60_000;
const MAX_LIVE = 4;

interface Live {
  id: string;
  userId: string;
  store: string;
  def: { domains: string[]; home: string };
  session: BrowserSession;
  touched: number;
}

const live = new Map<string, Live>();

function sweep() {
  const now = Date.now();
  for (const l of live.values()) if (now - l.touched > IDLE_MS) void closeLive(l.id);
}
setInterval(sweep, 30_000).unref();

async function closeLive(id: string) {
  const l = live.get(id);
  live.delete(id);
  await l?.session.close().catch(() => {});
}

function own(id: string, userId: string) {
  const l = live.get(id);
  if (!l || l.userId !== userId) throw new Error("Essa janela de login fechou. Abra de novo.");
  l.touched = Date.now();
  return l;
}

export async function startStoreLogin(userId: string, store: string) {
  const def = await storeDefFor(userId, store);
  if (!def) throw new Error("Loja não encontrada.");
  // uma janela por pessoa
  for (const l of [...live.values()]) if (l.userId === userId) await closeLive(l.id);
  if (live.size >= MAX_LIVE) throw new Error("Muita gente conectando loja agora. Tente de novo em um minuto.");
  const session = await BrowserSession.open(false, { cookies: await storeCookies(userId, store) });
  await session.page.setViewport({ width: 420, height: 760, isMobile: true, hasTouch: false });
  const id = randomUUID();
  live.set(id, { id, userId, store, def, session, touched: Date.now() });
  await session.goto(def.home).catch(async (err) => {
    await closeLive(id);
    throw err;
  });
  return { id, width: 420, height: 760 };
}

export async function loginFrame(id: string, userId: string) {
  const l = own(id, userId);
  return Buffer.from(await l.session.page.screenshot({ type: "jpeg", quality: 60 }));
}

export type LoginInput = { type: "click"; x: number; y: number } | { type: "text"; text: string } | { type: "key"; key: string } | { type: "scroll"; dy: number } | { type: "back" };

const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete"]);

export async function loginInput(id: string, userId: string, input: LoginInput) {
  const l = own(id, userId);
  const page = l.session.page;
  switch (input?.type) {
    case "click": {
      const x = Math.max(0, Math.min(420, Number(input.x) || 0));
      const y = Math.max(0, Math.min(760, Number(input.y) || 0));
      await page.mouse.click(x, y);
      break;
    }
    case "text":
      await page.keyboard.type(String(input.text ?? "").slice(0, 200), { delay: 25 });
      break;
    case "key":
      if (!KEYS.has(input.key)) throw new Error("tecla não permitida");
      await page.keyboard.press(input.key as any);
      break;
    case "scroll":
      await page.mouse.wheel({ deltaY: Math.max(-1500, Math.min(1500, Number(input.dy) || 0)) });
      break;
    case "back":
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      break;
    default:
      throw new Error("ação inválida");
  }
  await new Promise((r) => setTimeout(r, 400));
  // a janela é só para entrar na loja: saiu do site dela, volta para o começo
  if ((await storeOfFor(userId, page.url())) !== l.store && page.url() !== "about:blank") await l.session.goto(l.def.home).catch(() => {});
  return { url: page.url() };
}

/** "Pronto, entrei": guarda os cookies da loja (criptografados) e fecha a janela. */
export async function finishStoreLogin(id: string, userId: string) {
  const l = own(id, userId);
  try {
    const cookies = await l.session.cookiesFor(l.def.domains);
    if (!cookies.length) throw new Error("A loja não guardou nenhum login. Entre na sua conta antes de concluir.");
    await saveStoreCookies(userId, l.store, cookies);
    return { ok: true, store: l.store };
  } finally {
    await closeLive(id);
  }
}

export async function cancelStoreLogin(id: string, userId: string) {
  if (live.get(id)?.userId === userId) await closeLive(id);
}

export async function saveStoreCookies(userId: string, store: string, cookies: StoredCookie[]) {
  await query(
    `INSERT INTO store_sessions (user_id, store, cookies) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, store) DO UPDATE SET cookies = $3, updated_at = now()`,
    [userId, store, encryptJson(cookies.slice(0, 300))],
  );
}

export async function storeCookies(userId: string, store: string): Promise<StoredCookie[]> {
  const row = await one("SELECT cookies FROM store_sessions WHERE user_id = $1 AND store = $2", [userId, store]);
  if (!row) return [];
  try {
    return decryptJson<StoredCookie[]>(row.cookies);
  } catch {
    return [];
  }
}

/** Cookies da loja dessa URL, se a pessoa conectou a conta dela. */
export async function cookiesForUrl(userId: string, url: string) {
  const store = await storeOfFor(userId, url);
  return store ? { store, cookies: await storeCookies(userId, store) } : { store: null, cookies: [] };
}

/** Lojas para a tela: as do catálogo e as que a pessoa cadastrou, com login conectado e acesso salvo. */
export async function connectedStores(userId: string) {
  const [rows, access, defs] = await Promise.all([
    many("SELECT store, updated_at FROM store_sessions WHERE user_id = $1", [userId]),
    many("SELECT store FROM store_logins WHERE user_id = $1", [userId]),
    storesOf(userId),
  ]);
  return Object.entries(defs).map(([id, s]) => {
    const r = rows.find((x) => x.store === id);
    return {
      id,
      name: s.name,
      site: s.domains[0]!,
      custom: Boolean(s.custom),
      connected: Boolean(r),
      updated_at: r?.updated_at ?? null,
      access: access.some((x) => x.store === id),
    };
  });
}

export async function disconnectStore(userId: string, store: string) {
  await query("DELETE FROM store_sessions WHERE user_id = $1 AND store = $2", [userId, store]);
}
