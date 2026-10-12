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

/** Uma figurinha a cada 10 min por conversa no máximo: tempero, não toda mensagem. */
const COOLDOWN_MS = 10 * 60_000;
const lastSent = new Map<string, number>();

export function stickerAllowed(conversationId: string, now = Date.now()) {
  const last = lastSent.get(conversationId) ?? 0;
  if (now - last < COOLDOWN_MS) return false;
  lastSent.set(conversationId, now);
  if (lastSent.size > 5000) lastSent.delete(lastSent.keys().next().value!);
  return true;
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
