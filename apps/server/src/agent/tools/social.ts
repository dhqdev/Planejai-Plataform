import { randomUUID } from "node:crypto";
import { cacheGet, cacheSet } from "../../shortmem.js";
import { createInvite, displayName, findContact, inviteStats, listContacts, notifyUser, relayText } from "../../social.js";
import { SCOPE_LABEL, SHARE_SCOPES, setShare, type ShareScope } from "../../sharing.js";
import { cancelWatch, createWatch, listWatches, updateWatch, type NotifyMode } from "../../watches.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

export const invitePerson = defineTool<{ name: string; phone: string; message_after_accept?: string; confirmed_by_user?: boolean }>({
  name: "invite_person",
  description:
    "Convida alguém para o Planejai pelo WhatsApp; quem aceita vira contato (quem já usa recebe só o pedido de contato). " +
    "Só sai depois do \"sim\" da pessoa. Recado para o convidado vai em message_after_accept e é entregue no aceite. " +
    "Só quando ela quer chamar a pessoa para o Planejai; mensagem comum é send_whatsapp.",
  parameters: obj(
    {
      name: { type: "string" },
      phone: { type: "string", description: "Com DDD" },
      message_after_accept: { type: "string" },
      ...CONFIRM_PARAM,
    },
    ["name", "phone"],
  ),
  async run(args, ctx) {
    const gate = await requireConfirmation(args, `Convidar ${args.name} (${args.phone}) para o Planejai pelo WhatsApp`, ctx);
    if (gate) return gate;
    const msg = args.message_after_accept?.trim();
    const r = await createInvite({ inviterUserId: ctx.user.id, name: args.name, phone: args.phone, afterAccept: msg });
    if ("already" in r) {
      // já são contatos (ou acabaram de virar, sem convite novo): o recado vai agora
      const sender = displayName(ctx.user as any);
      if (msg) await notifyUser(r.contactId!, relayText(sender, msg), undefined, { from: sender });
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

/** Foto guardada enquanto a pessoa não diz "sim" (o mesmo prazo da pendência). */
const PHOTO_TTL_S = 30 * 60;

export const sendToContact = defineTool<{ contact: string; message: string; attach_photo?: boolean; photo_key?: string; confirmed_by_user?: boolean }>({
  name: "send_to_contact",
  description:
    "Manda uma mensagem a um contato do Planejai em nome da pessoa; só sai depois do \"sim\". attach_photo=true encaminha a foto que ela mandou agora.",
  parameters: obj(
    {
      contact: { type: "string", description: "Nome do contato" },
      message: { type: "string", description: "Curto e natural" },
      attach_photo: { type: "boolean" },
      ...CONFIRM_PARAM,
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
        hint: "Para só mandar a mensagem, peça o número e use send_whatsapp (sem convite). invite_person só se ela quiser chamar a pessoa para o Planejai.",
      };
    }
    if (found.length > 1) return { error: "Mais de um contato com esse nome", options: found.map((c) => c.name) };
    const to = found[0]!;
    const keyPrefix = `pending-photo:${ctx.conversation.id}:`;
    if (!ctx.approvedAction) {
      // a foto só existe na memória desta rodada: guarda no Redis para ela ainda estar aqui no "sim"
      const { photo_key: _ignored, ...clean } = args;
      let stored: Record<string, unknown> = clean;
      if (args.attach_photo) {
        const photo = ctx.inboundImages?.at(-1);
        if (!photo) return { error: "Não há foto nesta mensagem para encaminhar." };
        const key = keyPrefix + randomUUID();
        if (!(await cacheSet(key, photo, PHOTO_TTL_S, 12_000_000))) return { error: "Não consegui guardar a foto agora. Peça para ela mandar a foto de novo daqui a pouco." };
        stored = { ...clean, photo_key: key };
      }
      const preview = args.message.length > 80 ? `${args.message.slice(0, 79)}…` : args.message;
      const gate = await requireConfirmation(args, `Mandar para ${to.name}: "${preview}"${args.attach_photo ? " com a foto" : ""}`, {
        ...ctx,
        toolCall: { name: ctx.toolCall?.name ?? "send_to_contact", args: stored },
      });
      if (gate) return gate;
    }
    let photo: { base64: string; mimetype: string } | undefined;
    let photoExpired = false;
    if (args.attach_photo) {
      const key = typeof args.photo_key === "string" && args.photo_key.startsWith(keyPrefix) ? args.photo_key : null;
      photo = (key ? await cacheGet<{ base64: string; mimetype: string }>(key) : null) ?? ctx.inboundImages?.at(-1);
      photoExpired = !photo;
    }
    const sender = displayName(ctx.user as any);
    await notifyUser(to.id, relayText(sender, args.message), photo, { from: sender });
    return {
      ok: true,
      sent_to: to.name,
      with_photo: Boolean(photo),
      ...(photoExpired ? { note: "A foto venceu antes do sim; mandei só o texto. Peça para ela mandar a foto de novo se quiser encaminhar." } : {}),
    };
  },
});

export const watchCreate = defineTool<{ kind: "price" | "news"; query: string; target_price?: number; every_hours?: number; days?: number; notify?: NotifyMode }>({
  name: "watch_create",
  description:
    "Fica de olho (padrão 7 dias, sem gastar IA): price = menor preço no Mercado Livre; news = novidades de um assunto. " +
    "Conta cada olhada; notify=changes só quando achar algo melhor.",
  parameters: obj(
    {
      kind: { type: "string", enum: ["price", "news"] },
      query: { type: "string" },
      target_price: { type: "number" },
      every_hours: { type: "number", description: "Padrão 8 (preço) ou 12 (notícia)" },
      days: { type: "number", description: "Padrão 7, máx. 30" },
      notify: { type: "string", enum: ["always", "changes"] },
    },
    ["kind", "query"],
  ),
  async run(args, ctx) {
    const w = await createWatch({
      userId: ctx.user.id,
      conversationId: ctx.conversation.id,
      kind: args.kind,
      query: args.query,
      target: args.target_price,
      everyHours: args.every_hours,
      days: args.days,
      notifyMode: args.notify,
    });
    return { ok: true, id: w.id, every_hours: w.every_hours, until: w.expires_at, notify: w.notify_mode, note: "A primeira olhada sai em até 15 minutos." };
  },
});

export const watchUpdate = defineTool<{ id: string; query?: string; target_price?: number; every_hours?: number; days?: number; notify?: NotifyMode; paused?: boolean; reactivate?: boolean }>({
  name: "watch_update",
  description:
    "Ajusta um acompanhamento (id de watch_list): busca, preço alvo, frequência, mais dias, notify, pausar ou reativar.",
  parameters: obj(
    {
      id: { type: "string" },
      query: { type: "string" },
      target_price: { type: "number" },
      every_hours: { type: "number" },
      days: { type: "number", description: "Mais N dias a partir de agora" },
      notify: { type: "string", enum: ["always", "changes"] },
      paused: { type: "boolean" },
      reactivate: { type: "boolean" },
    },
    ["id"],
  ),
  async run(args, ctx) {
    const w = await updateWatch(args.id, ctx.user.id, {
      query: args.query,
      target: args.target_price,
      every_hours: args.every_hours,
      days: args.days,
      notify_mode: args.notify,
      paused: args.paused,
      reactivate: args.reactivate,
    });
    if (!w) return { ok: false, error: "Acompanhamento não encontrado" };
    return { ok: true, id: w.id, query: w.query, every_hours: w.every_hours, until: w.expires_at, paused: w.paused, active: w.active, notify: w.notify_mode };
  },
});

export const watchList = defineTool<Record<string, never>>({
  name: "watch_list",
  description: "Lista o que o assistente está acompanhando para a pessoa.",
  parameters: obj({}),
  async run(_args, ctx) {
    const rows = await listWatches(ctx.user.id);
    return rows.slice(0, 20).map((r) => ({
      id: r.id,
      kind: r.kind,
      query: r.query,
      active: r.active,
      paused: r.paused,
      target: r.target,
      best: r.best,
      every_hours: r.every_hours,
      until: r.expires_at,
      notify: r.notify_mode,
      last: r.last_result?.summary ?? null,
    }));
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

export const shareScreen = defineTool<{ contact: string; screen: ShareScope; allow: boolean; confirmed_by_user?: boolean }>({
  name: "share_screen",
  description:
    "Libera (allow=true) ou tira um contato de ver as Finanças ou a Agenda da pessoa, só leitura. Só para contatos; o contato é avisado. Liberar só sai depois do \"sim\".",
  parameters: obj(
    {
      contact: { type: "string", description: "Nome do contato" },
      screen: { type: "string", enum: SHARE_SCOPES },
      allow: { type: "boolean" },
      ...CONFIRM_PARAM,
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
    const what = args.screen === "finance" ? "as finanças" : "a agenda";
    if (args.allow) {
      const gate = await requireConfirmation(args, `Liberar ${what} para ${c.name} ver no painel`, ctx);
      if (gate) return gate;
    }
    await setShare(ctx.user.id, c.id, args.screen, args.allow);
    const who = displayName(ctx.user as any).split(" ")[0];
    await notifyUser(c.id, args.allow ? `${who} liberou ${what} pra você ver no painel do Planejai.` : `${who} parou de compartilhar ${what} com você.`);
    return { ok: true, contact: c.name, screen: SCOPE_LABEL[args.screen], allowed: args.allow };
  },
});
