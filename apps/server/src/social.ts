import { randomBytes } from "node:crypto";
import { normalizePhone } from "./accounts.js";
import { humanize } from "./agent/humanize.js";
import { activeChannel, channels, playground } from "./channels/index.js";
import type { Channel } from "./channels/types.js";
import { config } from "./config.js";
import { many, one, query } from "./db/pool.js";
import { isOwner, phoneVariants, upsertConversation } from "./ingest.js";
import { QUEUES, getBoss } from "./queue/boss.js";
import { pushShort } from "./shortmem.js";
import { whatsapp } from "./whatsapp/session.js";

/**
 * Convites e contatos. Só se entra na plataforma por convite: quem é convidado recebe a mensagem no WhatsApp
 * e responde SIM ou NÃO. Aceitou, vira cliente ativo e contato de quem convidou, e os dois podem mandar
 * coisas um pro outro pelo assistente ("manda esse look pro Giovani").
 */

/** Canal de saída para quem ainda não tem conversa (sem WhatsApp configurado, cai no canal de teste). */
export function outboundChannel(): Channel {
  return activeChannel() ?? playground;
}

export const displayName = (u: { full_name?: string | null; name?: string | null; phone?: string }) => u.full_name || u.name || (u.phone ? `+${u.phone}` : "alguém");

const strip = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Endereço no WhatsApp: no Baileys pergunta ao WhatsApp qual variante (com ou sem o 9) existe. */
export async function jidFor(phone: string, channel: Channel): Promise<string> {
  if (channel.id !== "baileys") return phone;
  const sock = whatsapp.connected ? whatsapp.sock : null;
  if (sock) {
    for (const v of phoneVariants(phone)) {
      try {
        const [r] = (await sock.onWhatsApp(`${v}@s.whatsapp.net`)) ?? [];
        if (r?.exists) return r.jid;
      } catch {
        /* tenta a próxima */
      }
    }
  }
  return `${phone}@s.whatsapp.net`;
}

/** Conversa de WhatsApp da pessoa (cria se ela ainda não falou com o assistente). */
export async function conversationOf(userId: string, phone: string) {
  const conv = await one("SELECT * FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1", [userId]);
  if (conv) return { conv, channel: getChannelSafe(conv.channel) };
  const channel = outboundChannel();
  const jid = await jidFor(phone, channel);
  return { conv: await upsertConversation(userId, channel.id, jid), channel };
}

function getChannelSafe(id: string): Channel {
  if (id === "telegram" && channels.telegram) return channels.telegram;
  const c = activeChannel();
  if (c && c.id === id) return c;
  return id === "playground" ? playground : (c ?? playground);
}

export interface InviteInput {
  inviterUserId?: string | null;
  inviterAccountId?: string | null;
  name?: string | null;
  phone: string;
  email?: string | null;
  /** recado de quem convidou, entregue assim que a pessoa aceitar */
  afterAccept?: string | null;
}

async function link(a: string, b: string) {
  await query("INSERT INTO contacts (user_id, contact_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING", [a, b]);
}

/** O que alguém manda a um contato pelo assistente, com a dica de como responder. */
export function relayText(sender: string, message: string) {
  return `*${sender}* te mandou pelo Planejai:\n\n${message}\n\n_Para responder, é só me dizer o que falar pro ${sender.split(" ")[0]}._`;
}

/** Convites que cada pessoa (fora o dono) pode mandar por dia. */
const INVITES_PER_PERSON_DAY = 10;

export async function createInvite(input: InviteInput) {
  const phone = normalizePhone(input.phone);
  if (phone.length < 12 || phone.length > 15) throw new Error("Telefone inválido: use DDD e número (ex.: 19 99999-9999)");
  const variants = phoneVariants(phone);
  if (input.inviterUserId) {
    const me0 = await one("SELECT phone FROM users WHERE id = $1", [input.inviterUserId]);
    if (me0 && !isOwner(me0.phone)) {
      const today = await one("SELECT COUNT(*)::int AS n FROM invites WHERE inviter_user_id = $1 AND created_at > now() - interval '24 hours'", [input.inviterUserId]);
      if (today.n >= INVITES_PER_PERSON_DAY) throw new Error(`Limite de ${INVITES_PER_PERSON_DAY} convites por dia atingido. Amanhã dá para mandar mais.`);
    }
    const me = await one("SELECT phone FROM users WHERE id = $1", [input.inviterUserId]);
    if (me && variants.includes(me.phone)) throw new Error("Esse é o seu próprio número.");
    const already = await one(
      "SELECT u.id FROM contacts c JOIN users u ON u.id = c.contact_id WHERE c.user_id = $1 AND u.phone = ANY($2)",
      [input.inviterUserId, variants],
    );
    if (already) return { already: true as const, contactId: already.id as string, linked: false };
    // Já é cliente ativo e foi esta pessoa que trouxe (convite antigo sem contato, ex.: feito pelo painel do dono):
    // os dois já disseram sim um ao outro, então viram contatos direto, sem mandar outro convite.
    const target = await one("SELECT id, invited_by FROM users WHERE phone = ANY($1) AND status = 'active'", [variants]);
    if (target) {
      const mine =
        target.invited_by === input.inviterUserId ||
        (me && isOwner(me.phone) && (await one("SELECT 1 FROM invites WHERE phone = ANY($1) AND status = 'accepted' AND inviter_user_id IS NULL", [variants])));
      if (mine) {
        await link(input.inviterUserId, target.id);
        await query(
          "UPDATE invites SET status = 'accepted', responded_at = now(), invitee_user_id = $3 WHERE inviter_user_id = $1 AND phone = ANY($2) AND status = 'pending'",
          [input.inviterUserId, variants, target.id],
        );
        return { already: true as const, contactId: target.id as string, linked: true };
      }
    }
    const pending = await one(
      "SELECT * FROM invites WHERE inviter_user_id = $1 AND phone = ANY($2) AND status = 'pending' AND expires_at > now()",
      [input.inviterUserId, variants],
    );
    if (pending) {
      if (input.afterAccept?.trim()) await query("UPDATE invites SET after_accept = $2 WHERE id = $1", [pending.id, input.afterAccept.trim().slice(0, 1000)]);
      return { invite: pending, resent: false, existing: Boolean(target) };
    }
  }
  const code = randomBytes(6).toString("base64url").replace(/[-_]/g, "x").slice(0, 8).toUpperCase();
  const invite = await one(
    `INSERT INTO invites (code, inviter_user_id, inviter_account_id, name, phone, email, after_accept) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      code,
      input.inviterUserId ?? null,
      input.inviterAccountId ?? null,
      input.name?.trim().slice(0, 80) || null,
      phone,
      input.email?.trim().toLowerCase() || null,
      input.afterAccept?.trim().slice(0, 1000) || null,
    ],
  );
  await (await getBoss()).send(QUEUES.invite, { inviteId: invite.id }, { retryLimit: 3, retryDelay: 60 });
  const existing = Boolean(await one("SELECT 1 FROM users WHERE phone = ANY($1) AND status = 'active'", [variants]));
  return { invite, resent: false, existing };
}

/** Letras e números sem os que confundem (0/O, 1/I/L): o código é digitado na landing. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const INVITE_CODE_HOURS = 24;

/** Deixa o código digitado comparável: sem espaço, hífen ou minúscula. */
export const cleanInviteCode = (raw: unknown) => String(raw ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 16);

/**
 * Convite por código (botão Convidar do painel): gera um link e um código de 6 caracteres que valem 24h e servem
 * para um cadastro só. Não manda nada no WhatsApp; quem convidou compartilha como quiser e o telefone vem no cadastro.
 */
export async function createInviteCode(input: { inviterUserId?: string | null; inviterAccountId?: string | null; name?: string | null }) {
  if (input.inviterUserId) {
    const me = await one("SELECT phone FROM users WHERE id = $1", [input.inviterUserId]);
    if (me && !isOwner(me.phone)) {
      const today = await one("SELECT COUNT(*)::int AS n FROM invites WHERE inviter_user_id = $1 AND created_at > now() - interval '24 hours'", [input.inviterUserId]);
      if (today.n >= INVITES_PER_PERSON_DAY) throw new Error(`Limite de ${INVITES_PER_PERSON_DAY} convites por dia atingido. Amanhã dá para gerar mais.`);
    }
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = randomBytes(6);
    const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    const invite = await one(
      `INSERT INTO invites (code, inviter_user_id, inviter_account_id, name, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5)) ON CONFLICT (code) DO NOTHING RETURNING *`,
      [code, input.inviterUserId ?? null, input.inviterAccountId ?? null, input.name?.trim().slice(0, 80) || null, INVITE_CODE_HOURS],
    );
    if (invite) return invite;
  }
  throw new Error("Não deu para gerar o código agora. Tente de novo.");
}

export function inviteLink(code: string) {
  return `${config.PUBLIC_URL.replace(/\/$/, "")}/convite/${code}`;
}

/** Manda o convite pelo WhatsApp (roda no worker, que segura a conexão). */
export async function sendInvite(inviteId: string) {
  const inv = await one(
    `SELECT i.*, u.full_name AS inviter_full_name, u.name AS inviter_name, u.phone AS inviter_phone, a.name AS account_name
       FROM invites i LEFT JOIN users u ON u.id = i.inviter_user_id LEFT JOIN accounts a ON a.id = i.inviter_account_id WHERE i.id = $1`,
    [inviteId],
  );
  if (!inv || inv.status !== "pending" || inv.sent_at) return;
  // Proteção do número: convite vai para quem ainda não salvou o contato, o tipo de mensagem que mais leva a
  // denúncia e banimento. Espaça os envios e respeita um teto diário; o que passar espera a próxima hora.
  const pace = await one(
    `SELECT COUNT(*) FILTER (WHERE sent_at > now() - interval '24 hours')::int AS day,
            COALESCE(EXTRACT(EPOCH FROM now() - MAX(sent_at)), 1e9)::float AS since_last FROM invites`,
  );
  const later = async (seconds: number) =>
    (await getBoss()).send(QUEUES.invite, { inviteId }, { startAfter: Math.round(seconds), retryLimit: 3, retryDelay: 60 });
  if (pace.day >= config.INVITES_PER_DAY) return void (await later(3600));
  if (pace.since_last < config.INVITE_GAP_SECONDS) return void (await later(config.INVITE_GAP_SECONDS - pace.since_last + Math.random() * 30));
  const inviter = inv.inviter_user_id ? displayName({ full_name: inv.inviter_full_name, name: inv.inviter_name, phone: inv.inviter_phone }) : inv.account_name || "A equipe do Planejai";
  const hello = inv.name ? `Oi, ${String(inv.name).split(" ")[0]}! ` : "Oi! ";
  // quem já usa o Planejai não recebe o convite de novo: é só um pedido de contato
  const member = inv.inviter_user_id ? await one("SELECT 1 FROM users WHERE phone = ANY($1) AND status = 'active'", [phoneVariants(inv.phone)]) : null;
  const text = member
    ? `${hello}${inviter} quer te adicionar como contato aqui no Planejai, pra vocês mandarem coisas um pro outro por mim.\n\nResponda *SIM* para aceitar ou *NÃO* para recusar.`
    :
    `${hello}${inviter} te convidou para o *Planejai*, um assistente aqui no WhatsApp que organiza gastos, lembretes e pesquisas` +
    (inv.inviter_user_id ? `, e deixa vocês mandarem coisas um pro outro por aqui.` : ".") +
    `\n\nResponda *SIM* para aceitar ou *NÃO* para recusar. Ao aceitar, você concorda com os termos e a política de privacidade: ` +
    `${config.PUBLIC_URL.replace(/\/$/, "")}/privacidade` +
    `\n\nSe quiser acessar o painel: ${inviteLink(inv.code)}`;
  const channel = outboundChannel();
  const jid = await jidFor(inv.phone, channel);
  await channel.sendText(jid, text);
  await query("UPDATE invites SET sent_at = now() WHERE id = $1", [inviteId]);
}

const YES = /^(sim|s|aceito|aceitar|quero|bora|claro|pode|ok|sim quero|sim aceito)$/;
const NO = /^(nao|n|recuso|nao quero|nao obrigado|nao obrigada)$/;

/**
 * Resposta a um convite pendente, tratada sem IA (zero token). Devolve true se a mensagem era sobre o convite.
 * Pessoa ainda não ativa que manda qualquer outra coisa recebe a instrução de novo.
 */
export async function handleInviteReply(opts: { user: any; text: string; channel: Channel; remoteJid: string }): Promise<boolean> {
  const { user, channel, remoteJid } = opts;
  const pending = await many(
    `SELECT i.*, u.full_name AS inviter_full_name, u.name AS inviter_name, u.phone AS inviter_phone FROM invites i
       LEFT JOIN users u ON u.id = i.inviter_user_id
      WHERE i.phone = ANY($1) AND i.status = 'pending' AND i.expires_at > now() ORDER BY i.created_at`,
    [phoneVariants(user.phone)],
  );
  if (!pending.length) return false;
  const t = strip(opts.text ?? "");
  const yes = YES.test(t);
  const no = NO.test(t);
  if (!yes && !no) {
    if (user.status === "active") return false;
    await channel.sendText(remoteJid, "Para entrar no Planejai, responda *SIM* para aceitar o convite ou *NÃO* para recusar.").catch(() => {});
    return true;
  }
  const first = pending[0];
  const wasMember = user.status === "active";
  if (yes) {
    await query(
      `UPDATE users SET status = 'active', full_name = COALESCE(full_name, $2), email = COALESCE(email, $3),
         invited_by = COALESCE(invited_by, $4), terms_accepted_at = COALESCE(terms_accepted_at, now()) WHERE id = $1`,
      [user.id, first.name, first.email, first.inviter_user_id],
    );
  }
  for (const inv of pending) {
    await query("UPDATE invites SET status = $2, responded_at = now(), invitee_user_id = $3 WHERE id = $1", [inv.id, yes ? "accepted" : "declined", user.id]);
    if (yes) void import("./events.js").then((e) => e.emitEvent("user.activated", { user_id: user.id, phone: user.phone, name: inv.name ?? null, invite_id: inv.id }));
    if (yes && inv.inviter_user_id) await link(inv.inviter_user_id, user.id);
    if (inv.inviter_user_id) {
      const who = displayName({ full_name: user.full_name ?? inv.name, name: user.name, phone: user.phone });
      const note = yes
        ? `${who} aceitou seu convite${wasMember ? "" : " para o Planejai"}. Agora vocês podem mandar coisas um pro outro por aqui, é só me pedir.` +
          (inv.after_accept ? " Já entreguei o seu recado." : "")
        : `${who} preferiu não entrar no Planejai agora.`;
      await notifyUser(inv.inviter_user_id, note).catch(() => {});
    }
  }
  const inviters = pending.filter((p) => p.inviter_user_id).map((p) => displayName({ full_name: p.inviter_full_name, name: p.inviter_name, phone: p.inviter_phone }));
  const how = inviters.length ? `para mandar algo para ${inviters.join(" ou ")}, é só pedir: "manda isso pro ${inviters[0]!.split(" ")[0]}".` : "";
  const welcome = !yes
    ? wasMember
      ? "Tudo bem, não adicionei."
      : "Tudo bem, não vou te mandar mais nada. Se mudar de ideia, é só pedir um novo convite."
    : wasMember
      ? `Pronto, vocês agora são contatos! ${how ? how[0]!.toUpperCase() + how.slice(1) : ""}`.trim()
      : `Pronto, você está no Planejai!\n\nPode me mandar gastos, comprovantes, pedir lembretes ou pesquisas, tudo por aqui.` + (how ? ` E ${how}` : "");
  await channel.sendText(remoteJid, welcome).catch(() => {});
  // recado que quem convidou deixou para a hora do aceite
  if (yes) {
    for (const inv of pending.filter((p) => p.inviter_user_id && p.after_accept)) {
      const sender = displayName({ full_name: inv.inviter_full_name, name: inv.inviter_name, phone: inv.inviter_phone });
      await notifyUser(user.id, relayText(sender, inv.after_accept)).catch(() => {});
    }
  }
  return true;
}

/** Mensagem do sistema para a pessoa, e o assistente dela fica sabendo (vai para a memória curta). */
export async function notifyUser(userId: string, text: string, image?: { base64: string; mimetype: string }) {
  const u = await one("SELECT * FROM users WHERE id = $1", [userId]);
  if (!u) return;
  text = humanize(text);
  const { conv, channel } = await conversationOf(u.id, u.phone);
  await channel.sendText(conv.remote_jid, text);
  if (image) await channel.sendImage(conv.remote_jid, { base64: image.base64, mimetype: image.mimetype });
  await pushShort(conv.id, [{ id: Date.now(), role: "assistant", text: image ? `${text}\n[foto enviada junto]` : text, ts: Date.now() }]);
}

export async function listContacts(userId: string) {
  return many<{ id: string; name: string; phone: string }>(
    `SELECT u.id, COALESCE(u.full_name, u.name, '+' || u.phone) AS name, u.phone FROM contacts c JOIN users u ON u.id = c.contact_id
      WHERE c.user_id = $1 AND u.status = 'active' ORDER BY 2`,
    [userId],
  );
}

export async function findContact(userId: string, name: string) {
  const all = await listContacts(userId);
  const q = strip(name);
  const exact = all.filter((c) => strip(c.name) === q || strip(c.name).split(" ")[0] === q);
  if (exact.length) return exact;
  return all.filter((c) => strip(c.name).includes(q) || c.phone.endsWith(q.replace(/\D/g, "") || "#"));
}

export async function inviteStats(userId: string | null) {
  return one(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
            COUNT(*) FILTER (WHERE status = 'pending' AND expires_at > now())::int AS pending,
            COUNT(*) FILTER (WHERE status = 'declined')::int AS declined
       FROM invites WHERE ($1::uuid IS NULL OR inviter_user_id = $1)`,
    [userId],
  );
}
