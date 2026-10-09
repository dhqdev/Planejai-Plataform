import { cancelDirect, createDirect, describeDirect, listDirect } from "../../direct.js";
import { formatLocal, parseLocalDateTime } from "../../time.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

export const sendWhatsapp = defineTool<{ phone: string; message: string; name?: string; at?: string; in_minutes?: number; confirmed_by_user?: boolean }>({
  name: "send_whatsapp",
  description:
    "Manda uma mensagem normal no WhatsApp de qualquer número (cliente, fornecedor, restaurante), agora ou agendada com at/in_minutes. " +
    "Não convida para o Planejai nem cria contato. Só sai depois do sim. Se a pessoa responder, a resposta chega aqui.",
  parameters: obj(
    {
      phone: { type: "string", description: "WhatsApp com DDD" },
      message: { type: "string", description: "Texto final, do jeito que ela pediu" },
      name: { type: "string", description: "Nome de quem recebe" },
      at: { type: "string", description: "Agendar: AAAA-MM-DDTHH:MM local" },
      in_minutes: { type: "number" },
      ...CONFIRM_PARAM,
    },
    ["phone", "message"],
  ),
  async run(args, ctx) {
    let sendAt: Date | null = null;
    if (args.in_minutes != null && args.in_minutes > 0) sendAt = new Date(Date.now() + args.in_minutes * 60_000);
    else if (args.at) {
      try {
        sendAt = parseLocalDateTime(args.at, ctx.timezone);
      } catch {
        return { ok: false, error: `Data inválida: ${args.at}` };
      }
      if (sendAt.getTime() < Date.now() - 60_000) return { ok: false, error: `O horário ${formatLocal(sendAt, ctx.timezone)} já passou` };
    }
    const who = args.name ? `${args.name} (${args.phone})` : args.phone;
    const preview = args.message.length > 120 ? `${args.message.slice(0, 119)}…` : args.message;
    const gate = await requireConfirmation(args, `mandar para ${who}${sendAt ? ` em ${formatLocal(sendAt, ctx.timezone)}` : " agora"}: "${preview}"`, ctx);
    if (gate) return gate;
    return createDirect({ user: ctx.user as any, phone: args.phone, name: args.name, message: args.message, sendAt, timezone: ctx.timezone });
  },
});

export const directList = defineTool<Record<string, never>>({
  name: "direct_list",
  description: "Mensagens avulsas agendadas que ainda não saíram.",
  parameters: obj({}),
  async run(_args, ctx) {
    return { scheduled: (await listDirect(ctx.user.id)).map((d) => describeDirect(d, ctx.timezone)) };
  },
});

export const directCancel = defineTool<{ id: string }>({
  name: "direct_cancel",
  description: "Cancela uma mensagem avulsa agendada (id do direct_list).",
  parameters: obj({ id: { type: "string" } }, ["id"]),
  async run(args, ctx) {
    return cancelDirect(ctx.user.id, args.id);
  },
});
