import { prefsFor, styleHint } from "../../chatprefs.js";
import { cancelDirect, createDirect, describeDirect, directText, listDirect } from "../../direct.js";
import { hasContactPhone, saveContact, searchContacts } from "../../phonebook.js";
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
        if (file.att && "needs_confirmation" in gate) previewAttachment(ctx, file.att, directText(args.message, ctx.user as any));
        return gate;
      }
    }
    const r: any = await createDirect({ user: ctx.user as any, phone: args.phone, name: args.name, message: args.message, sendAt, timezone: ctx.timezone, attachment: file.att });
    if (r.no_whatsapp) {
      return { ...r, hint: "Conte a ela que esse número não tem WhatsApp e peça o número certo. Não refaça imagem nem arquivo: o que já foi feito vai junto quando ela mandar o número." };
    }
    // número novo com nome vira contato na agenda dela (o nome que ela já deu a um número fica como está)
    if (r.ok && args.name?.trim() && !(await hasContactPhone(ctx.user.id, args.phone))) {
      const saved = await saveContact(ctx.user.id, args.name, args.phone).catch(() => null);
      if (saved) r.saved_contact = `${saved.name} salvo nos Contatos`;
    }
    return r;
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
    "Procura na agenda de contatos da pessoa pelo nome (aceita erro de digitação e grafia diferente) ou parte do número. Use antes de pedir o número a ela. " +
    "Mais de um resultado com o mesmo nome: pergunte qual.",
  parameters: obj({ query: { type: "string", description: "nome, apelido ou parte do número" } }, ["query"]),
  async run(args, ctx) {
    const found = await searchContacts(ctx.user.id, args.query, 5);
    if (!found.length) return { contacts: [], note: "Ninguém com esse nome nem parecido na agenda dela. Peça o número e salve com contact_save." };
    // jeito combinado na tela Recados (tom, anotação): o texto da mensagem já sai assim
    const prefs = await prefsFor(ctx.user.id, found.map((c) => c.phone));
    const contacts = found.map((c) => {
      const style = styleHint(prefs[c.phone]);
      return { name: c.name, phone: c.phone, ...(c.label ? { label: c.label } : {}), ...(style ? { style } : {}) };
    });
    // parecido não é certeza: ela confirma quem é antes de mandar
    return found[0]!.approximate
      ? { contacts, approximate: true, note: "Não achei com essa grafia; esses são os parecidos. Pergunte se é um deles antes de mandar." }
      : { contacts };
  },
});

export const contactSave = defineTool<{ name?: string; phone?: string; contacts?: { name: string; phone: string }[] }>({
  name: "contact_save",
  description:
    "Cadastra ou corrige contatos na agenda da pessoa (nome e WhatsApp com DDD) quando ela pede (\"salva o número da Ana\", \"guarda esse contato como Marcos\"), " +
    "passa um número novo ou compartilha um cartão de contato. Vários de uma vez: use contacts. Não precisa de sim.",
  parameters: obj({
    name: { type: "string" },
    phone: { type: "string" },
    contacts: {
      type: "array",
      description: "para salvar vários de uma vez",
      items: obj({ name: { type: "string" }, phone: { type: "string" } }, ["name", "phone"]),
    },
  }),
  async run(args, ctx) {
    const list = [...(args.name || args.phone ? [{ name: args.name ?? "", phone: args.phone ?? "" }] : []), ...(Array.isArray(args.contacts) ? args.contacts : [])].slice(0, 50);
    if (!list.length) return { ok: false, error: "Faltou o nome e o número." };
    const saved: { name: string; phone: string }[] = [];
    const failed: { name: string; phone: string; error: string }[] = [];
    // um por vez: o mesmo número duas vezes fica com o último nome
    for (const c of list) {
      try {
        saved.push(await saveContact(ctx.user.id, c.name, c.phone));
      } catch (err) {
        failed.push({ name: String(c.name ?? ""), phone: String(c.phone ?? ""), error: (err as Error).message });
      }
    }
    if (!saved.length) return { ok: false, error: failed.map((f) => `${f.name || f.phone}: ${f.error}`).join("; ") };
    if (list.length === 1) return { ok: true, ...saved[0]! };
    return { ok: true, saved, ...(failed.length ? { failed } : {}) };
  },
});

/** Cartão de contato do WhatsApp ("me passa o número da Ana"): a pessoa toca e já salva ou abre a conversa. */
export const sendContactCard = defineTool<{ name: string; phone: string }>({
  name: "send_contact_card",
  description:
    "Manda o cartão de contato de alguém no chat (a pessoa toca para salvar ou conversar). Use quando ela pedir o número ou o contato de alguém; " +
    "pegue nome e número com contacts_search. Devolve media_id para [[media:ID]].",
  parameters: obj({ name: { type: "string" }, phone: { type: "string", description: "Com DDD; só números" } }, ["name", "phone"]),
  async run(args, ctx) {
    let digits = String(args.phone ?? "").replace(/\D/g, "");
    if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
    if (digits.length < 12 || digits.length > 15) return { ok: false, error: "Número incompleto: precisa do DDD." };
    const name = String(args.name ?? "").trim().slice(0, 60) || `+${digits}`;
    const id = ctx.outbox.addMedia({ kind: "contact", contact: { name, phone: digits }, fallbackText: `👤 ${name}: +${digits}` });
    return { media_id: id, how_to_send: `Coloque [[media:${id}]] na resposta, com uma frase curta.` };
  },
});
