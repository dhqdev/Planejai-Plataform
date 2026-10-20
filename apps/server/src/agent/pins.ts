import { getChannel } from "../channels/index.js";
import { many, one, query } from "../db/pool.js";

/**
 * O que o assistente fixa no chat ([[fixar]]): lista de compras, resumo do mês...
 * - Tudo desafixa sozinho depois de PIN_DAYS (unpinExpired, na limpeza de hora em hora).
 * - Lista de compras parada há mais de LIST_STALE_HOURS: itens novos viram outra lista, não entram na antiga
 *   (pedido do dono). Dentro do prazo, a versão nova da mesma lista troca a fixada antes.
 */
export const PIN_DAYS = 7;
export const LIST_STALE_HOURS = 12;

const LIST = /🛒|\blista\b[^\n]{0,30}\b(compras?|mercado|supermercado|feira|sacol[aã]o|hortifruti|farm[aá]cia|atacad\w*|padaria|a[cç]ougue)\b/i;
const BUY_TOPIC = /\b(compr\w*|lista|mercado|supermercado|feira|preciso|precisa|precisamos|acabou|acabaram|faltando|falta|faltou)\b/i;
const HOUR = 3_600_000;

export const isShoppingList = (text: string) => LIST.test(text);

/** Aviso para o CTO quando a última lista ficou parada e ela fala de comprar de novo (sem isso, nada vai no prompt). */
export function staleListNote(lastAt: number | null, now: number, text: string): string | null {
  if (!lastAt || now - lastAt < LIST_STALE_HOURS * HOUR || !BUY_TOPIC.test(text)) return null;
  const hours = Math.floor((now - lastAt) / HOUR);
  const ago = hours >= 48 ? `${Math.floor(hours / 24)} dias` : hours >= 24 ? "1 dia" : `${hours} horas`;
  return (
    `A última lista de compras dela ficou parada há ${ago}. Se ela está mandando coisas para comprar agora, monte uma lista NOVA ` +
    "só com o que ela mandou agora (sem os itens da antiga) e fixe com [[fixar]]; junte na antiga só se ela pedir. " +
    "Se ela só quer ver a antiga ou marcar o que comprou, use a antiga."
  );
}

export async function shoppingListNote(conversationId: string, text: string) {
  if (!BUY_TOPIC.test(text)) return null;
  const row = await one<{ at: Date }>(
    "SELECT MAX(pinned_at) AS at FROM pinned_messages WHERE conversation_id = $1 AND kind = 'lista'",
    [conversationId],
  );
  return staleListNote(row?.at ? new Date(row.at).getTime() : null, Date.now(), text);
}

/** Guarda o que foi fixado. Lista ainda dentro do prazo: a versão antiga dela sai do topo (fica só a atual). */
export async function recordPin(conv: { id: string; channel: string; remote_jid: string }, externalId: string, text: string) {
  const kind = isShoppingList(text) ? "lista" : "fixado";
  if (kind === "lista") {
    const old = await many<{ id: string; external_id: string }>(
      `UPDATE pinned_messages SET unpinned_at = now() WHERE conversation_id = $1 AND kind = 'lista' AND unpinned_at IS NULL
          AND pinned_at > now() - make_interval(hours => $2) RETURNING id, external_id`,
      [conv.id, LIST_STALE_HOURS],
    );
    const ch = getChannel(conv.channel);
    for (const o of old) await ch.unpinMessage?.(conv.remote_jid, o.external_id).catch(() => {});
  }
  await query("INSERT INTO pinned_messages (conversation_id, external_id, kind) VALUES ($1, $2, $3)", [conv.id, externalId, kind]);
}

/** Desafixa o que está fixado há mais de PIN_DAYS (o WhatsApp também tira sozinho; aqui garante e marca no banco). */
export async function unpinExpired(log?: { error: (...a: any[]) => void }) {
  const rows = await many<{ id: string; external_id: string; channel: string; remote_jid: string }>(
    `SELECT p.id, p.external_id, c.channel, c.remote_jid FROM pinned_messages p JOIN conversations c ON c.id = p.conversation_id
      WHERE p.unpinned_at IS NULL AND p.pinned_at < now() - make_interval(days => $1) ORDER BY p.id LIMIT 200`,
    [PIN_DAYS],
  );
  for (const r of rows) {
    try {
      await getChannel(r.channel).unpinMessage?.(r.remote_jid, r.external_id);
    } catch (err) {
      log?.error({ err }, "falha ao desafixar mensagem");
    }
    await query("UPDATE pinned_messages SET unpinned_at = now() WHERE id = $1", [r.id]);
  }
  return rows.length;
}
