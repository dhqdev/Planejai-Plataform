import { deleteUserAutomations } from "./agent/tools/automations.js";
import type { Channel } from "./channels/types.js";
import { pool, one, query, many } from "./db/pool.js";
import { isOwner, phoneVariants } from "./ingest.js";
import { clearShort } from "./shortmem.js";

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
  return { ok: true };
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
