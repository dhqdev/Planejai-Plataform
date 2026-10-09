import { config } from "../../config.js";
import { one } from "../../db/pool.js";
import { emitEvent } from "../../events.js";
import { isOwner } from "../../ingest.js";
import { notify } from "../../notifications.js";
import { QUEUES, getBoss } from "../../queue/boss.js";
import { defineTool, obj } from "./types.js";

const TOPICS = ["duvida", "problema", "reclamacao", "cobranca", "cancelamento", "dados", "sugestao", "outro"] as const;
const TOPIC_LABEL: Record<(typeof TOPICS)[number], string> = {
  duvida: "Dúvida",
  problema: "Problema",
  reclamacao: "Reclamação",
  cobranca: "Cobrança",
  cancelamento: "Cancelamento",
  dados: "Dados pessoais (LGPD)",
  sugestao: "Sugestão",
  outro: "Outro assunto",
};
/** Teto por pessoa: o canal é para falar com gente, não para virar fila de spam no WhatsApp do dono. */
const PER_DAY = 3;

/**
 * Falar com o responsável pela plataforma: o pedido fica guardado, vira notificação no painel do dono
 * e chega no WhatsApp dele pelo ramo support.requested do fluxo Eventos do n8n (sem n8n, pela nossa fila).
 */
export const contactOwner = defineTool<{ topic: (typeof TOPICS)[number]; message: string }>({
  name: "contact_owner",
  description:
    "Leva um recado da pessoa ao responsável pelo Planejai (gente, não o assistente): quando ela pede para falar com o dono, suporte ou um humano, " +
    "reclama, relata erro do app, fala de cobrança, cancelamento ou dos dados dela (LGPD). message = o pedido em 1 a 3 frases, nas palavras dela.",
  parameters: obj(
    {
      topic: { type: "string", enum: [...TOPICS] },
      message: { type: "string", description: "o pedido, curto e com o que o responsável precisa para responder" },
    },
    ["topic", "message"],
  ),
  async run(args, ctx) {
    if (isOwner(ctx.user.phone)) return { ok: false, error: "Você já é o responsável pela plataforma." };
    const message = String(args.message ?? "").trim().slice(0, 800);
    if (message.length < 3) return { ok: false, error: "Falta dizer o que a pessoa quer." };
    const topic = TOPICS.includes(args.topic) ? args.topic : "outro";
    const today = await one<{ n: number }>("SELECT count(*)::int AS n FROM support_requests WHERE user_id = $1 AND created_at > now() - interval '1 day'", [ctx.user.id]);
    if ((today?.n ?? 0) >= PER_DAY) return { ok: false, error: "A pessoa já mandou 3 recados hoje; o responsável responde assim que puder." };
    const row = await one<{ id: string }>("INSERT INTO support_requests (user_id, topic, message) VALUES ($1, $2, $3) RETURNING id", [ctx.user.id, topic, message]);
    const who = (ctx.user as { full_name?: string | null }).full_name ?? ctx.user.name ?? "Cliente";
    const ownerText = `${TOPIC_LABEL[topic]} de ${who} (+${ctx.user.phone}):\n\n${message}\n\nResponda direto no WhatsApp dessa pessoa.`;
    await notify({ userId: null, kind: "suporte", title: `${TOPIC_LABEL[topic]} de ${who}`, body: message, link: "/clients" });
    const sent = await emitEvent("support.requested", { user_id: ctx.user.id, request_id: row!.id, topic, message, name: who, phone: ctx.user.phone, owner_text: ownerText });
    const ownerPhone = config.OWNER_PHONES[0];
    if (!sent && ownerPhone) await (await getBoss()).send(QUEUES.outbound, { type: "send", userId: null, phone: ownerPhone, channel: "whatsapp", text: ownerText }, { retryLimit: 2 });
    return { ok: true, avisado: true, nota: "O responsável recebeu o recado e responde a pessoa pelo WhatsApp." };
  },
});
