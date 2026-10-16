import { cacheGet, cacheSet } from "../shortmem.js";

/**
 * Ids (no WhatsApp) das últimas mensagens que o assistente mandou em cada conversa, para "apaga isso" e para
 * fixar. Fica no Redis por 2 dias (o WhatsApp só deixa apagar para todos até mais ou menos esse prazo).
 */
const TTL = 2 * 86_400;
const MAX = 12;
const key = (conversationId: string) => `pj:sent-ids:${conversationId}`;

export interface SentRef {
  id: string;
  at: number;
  /** começo do texto (ou [foto], [figurinha]...), para o agente saber o que está apagando */
  what: string;
}

export async function rememberOurs(conversationId: string, id: string | undefined, what: string) {
  if (!id) return;
  const list = (await cacheGet<SentRef[]>(key(conversationId)).catch(() => null)) ?? [];
  list.push({ id, at: Date.now(), what: what.slice(0, 80) });
  await cacheSet(key(conversationId), list.slice(-MAX), TTL).catch(() => false);
}

/** As últimas mensagens nossas, a mais nova primeiro. */
export async function lastOurs(conversationId: string): Promise<SentRef[]> {
  return ((await cacheGet<SentRef[]>(key(conversationId)).catch(() => null)) ?? []).slice().reverse();
}

export async function forgetOurs(conversationId: string, ids: string[]) {
  const list = (await cacheGet<SentRef[]>(key(conversationId)).catch(() => null)) ?? [];
  await cacheSet(key(conversationId), list.filter((r) => !ids.includes(r.id)), TTL).catch(() => false);
}
