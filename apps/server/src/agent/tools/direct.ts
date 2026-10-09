import { cancelDirect, createDirect, describeDirect, directText, listDirect } from "../../direct.js";
import { saveContact, searchContacts } from "../../phonebook.js";
import { formatLocal, parseLocalDateTime } from "../../time.js";
import { ATTACH_PARAMS, previewAttachment, resolveAttachment, type AttachArgs } from "./attach.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

/** at (horário local) ou in_minutes -> quando sai; null = agora. Usado por send_whatsapp e send_to_contact. */
export function parseSendAt(args: { at?: string; in_minutes?: number }, timezone: string): { sendAt: Date | null } | { error: string } {
  if (args.in_minutes != null && args.in_minutes > 0) return { sendAt: new Date(Date.now() + args.in_minutes * 60_000) };
  if (!args.at) return { sendAt: null };
  let sendAt: Date;
  try {
    sendAt = parseLocalDateTime(args.at, timezone);
  } catch {
    return { error: `Data inválida: ${args.at}` };
  }
  if (sendAt.getTime() < Date.now() - 60_000) return { error: `O horário ${formatLocal(sendAt, timezone)} já passou` };
  return { sendAt };
}

export const sendWhatsapp = defineTool<{ phone: string; message: string; name?: string; at?: string; in_minutes?: number; confirmed_by_user?: boolean } & AttachArgs>({
  name: "send_whatsapp",
  description:
    "Manda uma mensagem normal no WhatsApp de qualquer número (cliente, fornecedor, restaurante), agora ou agendada com at/in_minutes, com foto ou documento se pedir (attach/document_id). " +
    "Não convida para o Planejai nem cria contato. Só sai depois do sim. Se a pessoa responder, a resposta chega aqui.",
  parameters: obj(
    {
      phone: { type: "string", description: "WhatsApp com DDD" },
      message: { type: "string", description: "Texto final, do jeito que ela pediu" },
      name: { type: "string", description: "Nome de quem recebe" },
      ...ATTACH_PARAMS,
      at: { type: "string", description: "Agendar: AAAA-MM-DDTHH:MM local" },
      in_minutes: { type: "number" },
      ...CONFIRM_PARAM,
    },
    ["phone", "message"],
  ),
  async run(args, ctx) {
    const when = parseSendAt(args, ctx.timezone);
    if ("error" in when) return { ok: false, error: when.error };
    const sendAt = when.sendAt;
    const file = await resolveAttachment(args, ctx);
    if ("error" in file) return { ok: false, error: file.error };
    if (!ctx.approvedAction) {
      const who = args.name ? `${args.name} (${args.phone})` : args.phone;
      const preview = args.message.length > 120 ? `${args.message.slice(0, 119)}…` : args.message;
      const summary = `mandar para ${who}${sendAt ? ` em ${formatLocal(sendAt, ctx.timezone)}` : " agora"}: "${preview}"${file.label ? ` ${file.label}` : ""}`;
      const gate = await requireConfirmation(args, summary, { ...ctx, toolCall: { name: ctx.toolCall?.name ?? "send_whatsapp", args: file.stored } });
      if (gate) {
        if (file.att) previewAttachment(ctx, file.att, directText(args.message, ctx.user as any));
        return gate;
      }
    }
    return createDirect({ user: ctx.user as any, phone: args.phone, name: args.name, message: args.message, sendAt, timezone: ctx.timezone, attachment: file.att });
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

export const contactsSearch = defineTool<{ query: string }>({
  name: "contacts_search",
  description:
    "Procura na agenda de contatos da pessoa (importada do celular) pelo nome ou parte do número. Use antes de pedir o número a ela. " +
    "Mais de um resultado com o mesmo nome: pergunte qual.",
  parameters: obj({ query: { type: "string", description: "nome, apelido ou parte do número" } }, ["query"]),
  async run(args, ctx) {
    const found = await searchContacts(ctx.user.id, args.query, 5);
    return found.length ? { contacts: found.map((c) => ({ name: c.name, phone: c.phone, ...(c.label ? { label: c.label } : {}) })) } : { contacts: [], note: "Ninguém com esse nome na agenda dela." };
  },
});

export const contactSave = defineTool<{ name: string; phone: string }>({
  name: "contact_save",
  description: "Salva ou corrige um contato na agenda da pessoa (nome e WhatsApp com DDD), quando ela pede ou passa um número novo.",
  parameters: obj({ name: { type: "string" }, phone: { type: "string" } }, ["name", "phone"]),
  async run(args, ctx) {
    try {
      return { ok: true, ...(await saveContact(ctx.user.id, args.name, args.phone)) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
});
