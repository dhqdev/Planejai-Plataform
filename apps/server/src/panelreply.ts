import { config } from "./config.js";
import { many, one, query } from "./db/pool.js";
import { createDirect, personText } from "./direct.js";
import type { Errand } from "./errands.js";
import { isOwner, phoneVariants } from "./ingest.js";
import { isOptedOut, OPTED_OUT_ERROR } from "./outreach.js";
import { outboundChannel } from "./social.js";

export const PANEL_REPLY_MAX = 2000;

/**
 * A própria pessoa responde pela tela Recados. Só numa conversa que o assistente já tem por ela (recado, conversa
 * delegada ou mensagem avulsa): o painel não vira um WhatsApp para qualquer número. Sai pelo nosso número, com o
 * nome dela na frente ("*David:* ..."), e fica na conversa como dela.
 * - Recado ou conversa delegada aberta: entra no histórico do recado (o agente lê na próxima vez e sabe que não foi ele).
 * - Senão: mensagem avulsa da pessoa (limites, SAIR e a resposta volta para ela por 3 dias).
 * Tocar em Enviar no painel logado é o "sim": quem escreveu e mandou foi a pessoa, não o modelo.
 */
export async function replyFromPanel(userId: string, phone: string, message: string) {
  const text = message.trim().slice(0, PANEL_REPLY_MAX);
  if (!text) return { ok: false as const, error: "Escreva a mensagem." };
  const variants = phoneVariants(phone.replace(/\D/g, ""));
  const user = await one<{ id: string; phone: string; name: string | null; full_name: string | null; timezone: string | null }>(
    "SELECT id, phone, name, full_name, timezone FROM users WHERE id = $1",
    [userId],
  );
  if (!user) return { ok: false as const, error: "Conta sem WhatsApp ligado." };
  const [errand] = await many<Errand>(
    "SELECT * FROM errands WHERE user_id = $1 AND phone = ANY($2) AND status IN ('waiting', 'asking') AND expires_at > now() ORDER BY updated_at DESC LIMIT 1",
    [userId, variants],
  );
  if (errand) {
    if (await isOptedOut(errand.phone)) return { ok: false as const, error: OPTED_OUT_ERROR };
    const out = personText(text, user);
    await outboundChannel().sendText(errand.jid, out);
    // não conta no limite do agente: quem escreveu foi a pessoa
    await query("UPDATE errands SET log = log || $2::jsonb, updated_at = now() WHERE id = $1", [errand.id, JSON.stringify([{ from: "voce", text, at: new Date().toISOString() }])]);
    return { ok: true as const };
  }
  const known = await one<{ phone: string; name: string | null }>(
    `SELECT phone, name FROM (
       SELECT phone, name, created_at FROM contact_messages WHERE user_id = $1 AND phone = ANY($2)
       UNION ALL SELECT phone, place AS name, created_at FROM errands WHERE user_id = $1 AND phone = ANY($2)
       UNION ALL SELECT phone, name, created_at FROM direct_messages WHERE user_id = $1 AND phone = ANY($2)
     ) t ORDER BY (name IS NULL), created_at DESC LIMIT 1`,
    [userId, variants],
  );
  if (!known) return { ok: false as const, error: "Por aqui só dá para responder conversas que o assistente já começou. Peça no chat para mandar a primeira." };
  if (isOwner(known.phone) && !isOwner(user.phone)) return { ok: false as const, error: "Esse número não recebe mensagem por aqui." };
  const r: any = await createDirect({ user, phone: known.phone, name: known.name, message: text, timezone: user.timezone ?? config.DEFAULT_TIMEZONE, fromPanel: true });
  if (!r.ok) return { ok: false as const, error: String(r.error ?? "Não deu para mandar.") };
  return { ok: true as const, tip: (r.tip as string | undefined) ?? null };
}

