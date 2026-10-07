import { createInvite, displayName, findContact, inviteStats, listContacts, notifyUser } from "../../social.js";
import { cancelWatch, createWatch, listWatches } from "../../watches.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

export const invitePerson = defineTool<{ name: string; phone: string; confirmed_by_user?: boolean }>({
  name: "invite_person",
  description:
    "Convida alguém para o Planejai pelo WhatsApp (a pessoa responde SIM ou NÃO). Quem aceita vira contato e vocês podem mandar coisas um pro outro. " +
    "É mensagem para terceiro: só com confirmed_by_user=true depois que a pessoa confirmar nome e número.",
  parameters: obj({ name: { type: "string" }, phone: { type: "string", description: "Celular com DDD" }, ...CONFIRM_PARAM }, ["name", "phone"]),
  async run(args, ctx) {
    const gate = requireConfirmation(args, `Convidar ${args.name} (${args.phone}) para o Planejai pelo WhatsApp`);
    if (gate) return gate;
    const r = await createInvite({ inviterUserId: ctx.user.id, name: args.name, phone: args.phone });
    if ("already" in r) return { ok: true, note: `${args.name} já é seu contato.` };
    const stats = await inviteStats(ctx.user.id);
    return { ok: true, sent_to: r.invite.phone, invites_sent_total: stats?.total, accepted_total: stats?.accepted };
  },
});

export const listContactsTool = defineTool<Record<string, never>>({
  name: "list_contacts",
  description: "Lista os contatos da pessoa no Planejai (quem aceitou convite) e quantos convites ela já mandou.",
  parameters: obj({}),
  async run(_args, ctx) {
    const [contacts, stats] = await Promise.all([listContacts(ctx.user.id), inviteStats(ctx.user.id)]);
    return { contacts: contacts.map((c) => c.name), invites: stats };
  },
});

export const sendToContact = defineTool<{ contact: string; message: string; attach_photo?: boolean }>({
  name: "send_to_contact",
  description:
    "Manda algo para um contato do Planejai pelo WhatsApp, a pedido da pessoa (ex.: 'manda esse look pro Giovani'). " +
    "attach_photo=true encaminha a foto que a pessoa mandou agora. O contato aceitou receber, então não precisa de confirmação quando o pedido é claro.",
  parameters: obj(
    {
      contact: { type: "string", description: "Nome do contato" },
      message: { type: "string", description: "O que dizer, em nome da pessoa (curto, natural)" },
      attach_photo: { type: "boolean" },
    },
    ["contact", "message"],
  ),
  async run(args, ctx) {
    const found = await findContact(ctx.user.id, args.contact);
    if (!found.length) {
      const all = await listContacts(ctx.user.id);
      return { error: `${args.contact} não é contato no Planejai.`, contacts: all.map((c) => c.name), hint: "Ofereça convidar com invite_person." };
    }
    if (found.length > 1) return { error: "Mais de um contato com esse nome", options: found.map((c) => c.name) };
    const to = found[0]!;
    const photo = args.attach_photo ? ctx.inboundImages?.at(-1) : undefined;
    if (args.attach_photo && !photo) return { error: "Não há foto nesta mensagem para encaminhar." };
    const sender = displayName(ctx.user as any);
    await notifyUser(to.id, `*${sender}* te mandou pelo Planejai:\n\n${args.message}`, photo);
    return { ok: true, sent_to: to.name, with_photo: Boolean(photo) };
  },
});

export const watchCreate = defineTool<{ kind: "price" | "news"; query: string; target_price?: number; every_hours?: number }>({
  name: "watch_create",
  description:
    "Fica de olho em algo e avisa a pessoa sozinho quando achar algo melhor: kind=price acompanha o menor preço de um produto (Mercado Livre), " +
    "kind=news avisa de novidades sobre um assunto. Ofereça quando a pessoa quer comprar algo, espera um preço ou uma notícia. A checagem não gasta IA.",
  parameters: obj(
    {
      kind: { type: "string", enum: ["price", "news"] },
      query: { type: "string", description: "O que buscar, ex.: 'iPhone 16 128GB'" },
      target_price: { type: "number", description: "Preço alvo em reais (opcional)" },
      every_hours: { type: "number", description: "De quantas em quantas horas olhar (padrão 6 para preço, 12 para notícia)" },
    },
    ["kind", "query"],
  ),
  async run(args, ctx) {
    const w = await createWatch({ userId: ctx.user.id, conversationId: ctx.conversation.id, kind: args.kind, query: args.query, target: args.target_price, everyHours: args.every_hours });
    return { ok: true, id: w.id, every_hours: w.every_hours, until: w.expires_at };
  },
});

export const watchList = defineTool<Record<string, never>>({
  name: "watch_list",
  description: "Lista o que o assistente está acompanhando para a pessoa.",
  parameters: obj({}),
  async run(_args, ctx) {
    const rows = await listWatches(ctx.user.id);
    return rows.filter((r) => r.active).map((r) => ({ id: r.id, kind: r.kind, query: r.query, target: r.target, best: r.best, every_hours: r.every_hours }));
  },
});

export const watchCancel = defineTool<{ id: string }>({
  name: "watch_cancel",
  description: "Para de acompanhar algo (id vindo de watch_list).",
  parameters: obj({ id: { type: "string" } }, ["id"]),
  async run(args, ctx) {
    return { ok: await cancelWatch(args.id, ctx.user.id) };
  },
});
