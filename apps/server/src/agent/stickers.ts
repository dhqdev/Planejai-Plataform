import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Figurinhas do Mochi (webp 512x512 em assets/stickers) que o CTO pode mandar com [[figurinha:nome]]. */
export const STICKERS = [
  "oi", "feliz", "pronto", "rindo", "piscando", "pensando", "surpreso", "curioso", "triste", "festa", "com-sono", "dormindo",
  "coroa", "flor", "laco", "oculos-escuros", "fone", "cachecol", "gorro", "papai-noel", "abobora", "bruxa",
] as const;

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "stickers");
const cache = new Map<string, string>();

/** Base64 da figurinha, ou null se o nome não existe. */
export function stickerBase64(name: string): string | null {
  const n = name.trim().toLowerCase().replace(/[\s_]+/g, "-").normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (!(STICKERS as readonly string[]).includes(n)) return null;
  if (!cache.has(n)) cache.set(n, readFileSync(join(DIR, `${n}.webp`)).toString("base64"));
  return cache.get(n)!;
}

/** Intervalo mínimo por conversa: frequente, mas sem virar toda mensagem. */
const STICKER_GAP_MS = 3 * 60_000;
const GIF_GAP_MS = 5 * 60_000;
const lastSent = new Map<string, number>();

function allowed(key: string, gap: number, now: number) {
  const last = lastSent.get(key) ?? 0;
  if (now - last < gap) return false;
  lastSent.set(key, now);
  if (lastSent.size > 5000) lastSent.delete(lastSent.keys().next().value!);
  return true;
}

export const stickerAllowed = (conversationId: string, now = Date.now()) => allowed(`s:${conversationId}`, STICKER_GAP_MS, now);
export const gifAllowed = (conversationId: string, now = Date.now()) => allowed(`g:${conversationId}`, GIF_GAP_MS, now);

const GIF_MARK = /[ \t]*\[\[gif:([^\]]+)\]\][ \t]*/gi;

/**
 * Troca o primeiro [[gif:busca]] por [[media:ID]] (o servidor busca na Klipy/Giphy, sem outra rodada do modelo).
 * Com GIF na resposta, figurinha some (uma mídia de reação por vez). Sem GIF achado, intervalo ou provedor, o marcador some.
 */
export async function placeGifs(text: string, conversationId: string, fetch: ((q: string) => Promise<string | null>) | null, add: (base64: string) => string) {
  const first = [...text.matchAll(GIF_MARK)][0];
  let id: string | null = null;
  if (first && fetch && gifAllowed(conversationId)) {
    const b64 = await fetch(first[1]!).catch(() => null);
    if (b64) id = add(b64);
  }
  let out = text.replace(GIF_MARK, (m) => (id && m === first![0] ? `\n---\n[[media:${id}]]\n---\n` : " ")).replace(/(\S)[ \t]{2,}/g, "$1 ");
  if (id) out = out.replace(/[ \t]*\[\[figurinha:[^\]]+\]\][ \t]*/gi, "");
  return out.replace(/^(?:\s*---\s*\n)+/, "").replace(/(?:\n\s*---\s*)+$/, "").trim();
}

/**
 * Troca [[figurinha:nome]] por [[media:ID]] (uma por resposta, respeitando o intervalo); nome que não existe some.
 * `add` guarda a figurinha no outbox e devolve o id da mídia.
 */
export function placeStickers(text: string, conversationId: string, add: (base64: string) => string) {
  let used = false;
  return text
    .replace(/[ \t]*\[\[figurinha:([^\]]+)\]\][ \t]*/gi, (_m, name: string) => {
      const b64 = !used ? stickerBase64(name) : null;
      if (!b64 || !stickerAllowed(conversationId)) return "";
      used = true;
      return `\n---\n[[media:${add(b64)}]]\n---\n`;
    })
    .replace(/^(?:\s*---\s*\n)+/, "")
    .replace(/(?:\n\s*---\s*)+$/, "")
    .trim();
}
