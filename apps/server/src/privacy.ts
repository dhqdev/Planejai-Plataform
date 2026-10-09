import { deleteUserAutomations } from "./agent/tools/automations.js";
import type { Channel } from "./channels/types.js";
import { pool, one, query, many } from "./db/pool.js";
import { isOwner, phoneVariants } from "./ingest.js";
import { clearConversationCache, clearShort } from "./shortmem.js";
import { purgeStorageTrash } from "./storage.js";

/**
 * LGPD: "apague tudo meu". Remove a pessoa e tudo que é dela (gastos, limites, lembretes, memórias,
 * acompanhamentos, contatos, agentes, conversas, logs, arquivos, convites e login do painel).
 * Fica só o que não é dela: convites que outras pessoas mandaram para outros números, por exemplo.
 */
export async function eraseUserData(userId: string): Promise<{ ok: boolean }> {
  const user = await one("SELECT id, phone FROM users WHERE id = $1", [userId]);
  if (!user) return { ok: false };
  const convs = await many<{ id: string }>("SELECT id FROM conversations WHERE user_id = $1", [userId]);
  await deleteUserAutomations(userId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // executions e accounts só soltam a pessoa (SET NULL) quando ela some; aqui saem de verdade
    await client.query("DELETE FROM executions WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM accounts WHERE user_id = $1 OR phone = ANY($2)", [userId, phoneVariants(user.phone)]);
    await client.query("DELETE FROM invites WHERE invitee_user_id = $1 OR phone = ANY($2)", [userId, phoneVariants(user.phone)]);
    await client.query("DELETE FROM users WHERE id = $1", [userId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  for (const c of convs) await clearShort(c.id);
  // documentos e mídias no bucket (o gatilho anotou em storage_trash); o que falhar sai na limpeza de hora em hora
  await purgeStorageTrash(1000).catch(() => {});
  return { ok: true };
}

/**
 * "Zerar contexto" (aba Clientes): o assistente esquece a conversa com a pessoa e começa do zero, sem apagar a conta.
 * Sai: memória curta no Redis, mensagens já respondidas e o resumo da conversa, o que esperava o "sim" e o cache da conversa.
 * Com memories=true sai também o que ele aprendeu dela (memórias, jeito de falar e notas por agente).
 * Ficam: cadastro, gastos, lembretes, agenda, documentos, contatos e mensagens ainda não respondidas.
 */
export async function resetContext(userId: string, opts: { memories?: boolean } = {}) {
  const user = await one("SELECT id FROM users WHERE id = $1", [userId]);
  if (!user) return { ok: false as const };
  const convs = await many<{ id: string }>("SELECT id FROM conversations WHERE user_id = $1", [userId]);
  const ids = convs.map((c) => c.id);
  const msgs = await query("DELETE FROM messages WHERE conversation_id = ANY($1) AND processed = true", [ids]);
  await query("UPDATE conversations SET summary = NULL WHERE id = ANY($1)", [ids]);
  await query("UPDATE pending_actions SET status = 'expired', resolved_at = now() WHERE conversation_id = ANY($1) AND status = 'pending'", [ids]);
  let cache = 0;
  for (const id of ids) {
    await clearShort(id);
    cache += await clearConversationCache(id);
  }
  let memories = 0;
  if (opts.memories) {
    memories = (await query("DELETE FROM memories WHERE user_id = $1", [userId])).rowCount ?? 0;
    await query("UPDATE users SET style_notes = NULL WHERE id = $1", [userId]);
    // a nota que a própria pessoa escreveu para um agente (user_note) é dela, não aprendizado: fica
    await query("UPDATE agent_notes SET note = NULL WHERE user_id = $1", [userId]);
    await query("DELETE FROM agent_notes WHERE user_id = $1 AND note IS NULL AND user_note IS NULL", [userId]);
  }
  return { ok: true as const, conversations: ids.length, messages: msgs.rowCount ?? 0, cache, memories };
}

const ASK = /^(por favor[, ]+)?(apag(ue|ar|a)|exclu(a|ir)|delet(e|ar))\s+(todos\s+)?(os\s+)?meus\s+dados\b/;
const CONFIRM = /^apagar tudo$/;
const norm = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[!.?]+$/g, "")
    .trim();

/**
 * Pedido de exclusão pelo WhatsApp, sem IA (zero token e sem o modelo errar): a pessoa pede, recebe o aviso
 * e confirma com APAGAR TUDO em até 10 minutos. Devolve true se a mensagem era sobre isso.
 */
export async function handleEraseRequest(opts: { user: any; text: string; channel: Channel; remoteJid: string }): Promise<boolean> {
  const { user, channel, remoteJid } = opts;
  const text = norm(opts.text ?? "");
  if (!text) return false;
  const askedAt = user.profile?.erase_requested_at ? new Date(user.profile.erase_requested_at).getTime() : 0;
  if (CONFIRM.test(text) && askedAt > Date.now() - 10 * 60_000) {
    if (isOwner(user.phone)) {
      await channel.sendText(remoteJid, "Você é o dono da plataforma, então por aqui eu não apago. Faça isso direto no banco se quiser mesmo.");
      return true;
    }
    await channel.sendText(remoteJid, "Pronto, apaguei tudo que era seu aqui: gastos, lembretes, memórias, contatos e login do painel. Se quiser voltar um dia, é só pedir um convite. 👋");
    await eraseUserData(user.id);
    return true;
  }
  if (ASK.test(text)) {
    await query("UPDATE users SET profile = profile || jsonb_build_object('erase_requested_at', now()) WHERE id = $1", [user.id]);
    await channel.sendText(
      remoteJid,
      "Posso apagar todos os seus dados do Planejai: gastos, limites, lembretes, memórias, contatos, acompanhamentos e o login do painel. " +
        "Isso não tem volta.\n\nSe tiver certeza, responda *APAGAR TUDO* nos próximos 10 minutos.",
    );
    return true;
  }
  return false;
}
