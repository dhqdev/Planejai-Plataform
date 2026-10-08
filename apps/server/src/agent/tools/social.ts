import { createInvite, displayName, findContact, inviteStats, listContacts, notifyUser, relayText } from "../../social.js";
import { SCOPE_LABEL, SHARE_SCOPES, setShare, type ShareScope } from "../../sharing.js";
import { cancelWatch, createWatch, listWatches } from "../../watches.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

export const invitePerson = defineTool<{ name: string; phone: string; message_after_accept?: string; confirmed_by_user?: boolean }>({
  name: "invite_person",
  description:
    "Convida alguém para o Planejai pelo WhatsApp (a pessoa responde SIM ou NÃO). Quem aceita vira contato e vocês podem mandar coisas um pro outro. " +
    "É mensagem para terceiro: só com confirmed_by_user=true depois que a pessoa confirmar nome e número. " +
    "Se ela quer dizer algo a essa pessoa ('convida o Jonathan e chama ele pro cinema'), passe em message_after_accept: é entregue sozinho quando o convite for aceito, ou na hora se já forem contatos. " +
    "Quem já usa o Planejai recebe só um pedido de contato, não o convite de novo.",
  parameters: obj(
    {
      name: { type: "string" },
      phone: { type: "string", description: "Celular com DDD" },
      message_after_accept: { type: "string", description: "Recado em nome da pessoa, curto e natural (opcional)" },
      ...CONFIRM_PARAM,
    },
    ["name", "phone"],
  ),
  async run(args, ctx) {
    const gate = requireConfirmation(args, `Convidar ${args.name} (${args.phone}) para o Planejai pelo WhatsApp`);
    if (gate) return gate;
    const msg = args.message_after_accept?.trim();
    const r = await createInvite({ inviterUserId: ctx.user.id, name: args.name, phone: args.phone, afterAccept: msg });
    if ("already" in r) {
      // já são contatos (ou acabaram de virar, sem convite novo): o recado vai agora
      if (msg) await notifyUser(r.contactId!, relayText(displayName(ctx.user as any), msg));
      return {
        ok: true,
        invite_sent: false,
        note:
          `${args.name} já ${r.linked ? "usava o Planejai e agora é seu contato" : "é seu contato"}; não mandei convite.` +
          (msg ? " O recado foi entregue agora." : " Para falar com ele, use send_to_contact."),
      };
    }
    const stats = await inviteStats(ctx.user.id);
    return {
      ok: true,
      sent_to: r.invite.phone,
      ...(r.existing ? { note: `${args.name} já usa o Planejai: foi um pedido de contato, não um convite novo.` } : {}),
      ...(msg
        ? { message_after_accept: "guardado; entrego sozinho quando aceitar" }
        : { hint: "Nada será enviado depois do aceite; se a pessoa quer mandar um recado, chame de novo com message_after_accept." }),
      invites_sent_total: stats?.total,
      accepted_total: stats?.accepted,
    };
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
      return {
        error: `${args.contact} não é contato no Planejai.`,
        contacts: all.map((c) => c.name),
        hint: "Peça o número e use invite_person com o recado em message_after_accept (se a pessoa já usa o Planejai, vira contato sem convite novo).",
      };
    }
    if (found.length > 1) return { error: "Mais de um contato com esse nome", options: found.map((c) => c.name) };
    const to = found[0]!;
    const photo = args.attach_photo ? ctx.inboundImages?.at(-1) : undefined;
    if (args.attach_photo && !photo) return { error: "Não há foto nesta mensagem para encaminhar." };
    const sender = displayName(ctx.user as any);
    await notifyUser(to.id, relayText(sender, args.message), photo);
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

export const shareScreen = defineTool<{ contact: string; screen: ShareScope; allow: boolean }>({
  name: "share_screen",
  description:
    "Finanças e Agenda de cada pessoa são particulares. Use quando ela pedir para deixar um contato ver (ou parar de ver) uma delas " +
    "(ex.: 'deixa a Ana ver minhas finanças'). Só vale para contatos (quem aceitou convite). Ver é só leitura; o contato é avisado.",
  parameters: obj(
    {
      contact: { type: "string", description: "Nome do contato" },
      screen: { type: "string", enum: SHARE_SCOPES },
      allow: { type: "boolean", description: "true = liberar, false = tirar o acesso" },
    },
    ["contact", "screen", "allow"],
  ),
  async run(args, ctx) {
    const found = await findContact(ctx.user.id, args.contact);
    if (found.length !== 1) {
      return found.length
        ? { error: "Mais de um contato com esse nome; pergunte qual.", options: found.map((c) => c.name) }
        : { error: `${args.contact} não é contato no Planejai. Só dá para compartilhar com quem aceitou um convite.`, contacts: (await listContacts(ctx.user.id)).map((c) => c.name) };
    }
    const c = found[0]!;
    await setShare(ctx.user.id, c.id, args.screen, args.allow);
    const what = args.screen === "finance" ? "as finanças" : "a agenda";
    const who = displayName(ctx.user as any).split(" ")[0];
    await notifyUser(c.id, args.allow ? `${who} liberou ${what} pra você ver no painel do Planejai.` : `${who} parou de compartilhar ${what} com você.`);
    return { ok: true, contact: c.name, screen: SCOPE_LABEL[args.screen], allowed: args.allow };
  },
});
