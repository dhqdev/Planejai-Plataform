import type { Channel } from "./channels/types.js";
import { one } from "./db/pool.js";
import { isOwner } from "./ingest.js";
import { getSettings } from "./settings.js";
import { SESSION_ID } from "./whatsapp/types.js";

/**
 * Status do WhatsApp só aparece para quem salvou o número do assistente. Na primeira conversa de cada cliente
 * (uma vez só por pessoa), depois da resposta: o assistente salva a pessoa na agenda do celular dele e manda o
 * próprio cartão de contato com um pedido curto para ela salvar. Do lado do cliente não dá para salvar sozinho.
 */
export const SAVE_ME_TEXT = "📌 Salva meu contato aí 👇 Assim você não me perde e vê as novidades que eu posto no status 😉";

export async function introduceOnce(
  channel: Channel,
  conversation: { remote_jid: string },
  user: { id: string; phone: string; name?: string | null },
) {
  if (channel.id !== "baileys" || !channel.rich || isOwner(user.phone)) return false;
  if (!/@(s\.whatsapp\.net|lid)$/.test(conversation.remote_jid)) return false;
  const first = await one(
    `UPDATE users SET profile = profile || jsonb_build_object('wa_saved_at', now()) WHERE id = $1
       AND profile->>'wa_saved_at' IS NULL RETURNING id`,
    [user.id],
  );
  if (!first) return false;
  const me = await one<{ phone: string | null; name: string | null }>("SELECT phone, name FROM wa_sessions WHERE id = $1", [SESSION_ID]).catch(() => null);
  const phone = me?.phone?.replace(/\D/g, "");
  if (phone) {
    const name = me?.name || (await getSettings()).assistantName || "Planejai";
    await channel.sendText(conversation.remote_jid, SAVE_ME_TEXT).catch(() => {});
    await channel.sendImage(conversation.remote_jid, { kind: "contact", contact: { name, phone }, fallbackText: `👤 ${name}: +${phone}` }).catch(() => {});
  }
  const lid = conversation.remote_jid.endsWith("@lid") ? conversation.remote_jid : undefined;
  await channel.saveContact?.(user.phone, user.name?.trim() || `+${user.phone}`, lid).catch(() => {});
  return true;
}
