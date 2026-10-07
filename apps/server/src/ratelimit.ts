import { countInWindow, peekCount } from "./shortmem.js";

/**
 * Contadores por janela (login, cadastro, convite). Usa o Redis da stack para valer entre réplicas;
 * sem Redis cai num contador em memória do processo, que já segura força bruta numa réplica só.
 */
const mem = new Map<string, { n: number; until: number }>();

function memEntry(key: string) {
  const e = mem.get(key);
  if (e && e.until > Date.now()) return e;
  mem.delete(key);
  return null;
}

/** Soma 1 e devolve quantas vezes aconteceu na janela. */
export async function hit(key: string, windowSeconds: number): Promise<number> {
  const n = await countInWindow(key, windowSeconds);
  if (n != null) return n;
  const e = memEntry(key) ?? { n: 0, until: Date.now() + windowSeconds * 1000 };
  e.n++;
  mem.set(key, e);
  if (mem.size > 50_000) mem.clear();
  return e.n;
}

/** Quantas vezes aconteceu na janela, sem somar. */
export async function peek(key: string): Promise<number> {
  const n = await peekCount(key);
  if (n != null) return n;
  return memEntry(key)?.n ?? 0;
}
