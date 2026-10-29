import type { InboundMessage } from "./channels/types.js";
import { config } from "./config.js";
import { one, query } from "./db/pool.js";
import { QUEUES, getBoss } from "./queue/boss.js";
import { getSettings } from "./settings.js";
import { countInWindow, markSeen } from "./shortmem.js";
import { handleInviteReply } from "./social.js";
import { getChannel } from "./channels/index.js";

/** Celulares do Brasil chegam no WhatsApp com ou sem o nono dígito (55 19 9xxxx-xxxx vs 55 19 xxxx-xxxx). */
export function phoneVariants(phone: string): string[] {
  const m = phone.match(/^55(\d{2})(9?)(\d{8})$/);
  if (!m) return [phone];
  return [`55${m[1]}9${m[3]}`, `55${m[1]}${m[3]}`];
}

export function isOwner(phone: string) {
  const variants = phoneVariants(phone);
  return config.OWNER_PHONES.some((o) => phoneVariants(o).some((v) => variants.includes(v)));
}

export async function upsertUser(phone: string, name?: string) {
  const status = isOwner(phone) || config.ALLOW_UNKNOWN_CONTACTS ? "active" : "pending";
  // o mesmo celular pode estar gravado com ou sem o nono dígito (cadastro no painel x número que o WhatsApp entrega):
  // acha a pessoa por qualquer das duas formas, senão quem acabou de se cadastrar vira um segundo usuário "aguardando aprovação"
  const existing = await one(
    `SELECT id FROM users WHERE phone = ANY($1)
     ORDER BY (status = 'blocked') DESC, (status = 'active') DESC, (phone = $2) DESC, created_at LIMIT 1`,
    [phoneVariants(phone), phone],
  );
  if (existing) {
    return one(
      `UPDATE users SET name = COALESCE(name, $2), last_seen_at = now(),
         status = CASE WHEN status = 'pending' AND $3 = 'active' THEN 'active' ELSE status END
       WHERE id = $1 RETURNING *`,
      [existing.id, name ?? null, status],
    );
  }
  return one(
    `INSERT INTO users (phone, name, status, last_seen_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (phone) DO UPDATE SET name = COALESCE(users.name, EXCLUDED.name), last_seen_at = now(),
       status = CASE WHEN users.status = 'pending' AND EXCLUDED.status = 'active' THEN 'active' ELSE users.status END
     RETURNING *`,
    [phone, name ?? null, status],
  );
}

export async function upsertConversation(userId: string, channel: string, remoteJid: string) {
  return one(
    `INSERT INTO conversations (user_id, channel, remote_jid) VALUES ($1, $2, $3)
     ON CONFLICT (channel, remote_jid) DO UPDATE SET user_id = EXCLUDED.user_id, updated_at = now() RETURNING *`,
    [userId, channel, remoteJid],
  );
}

/** Guarda a mensagem recebida e agenda o processamento (com debounce, para juntar mensagens seguidas). */
export async function ingest(msg: InboundMessage): Promise<{ queued: boolean; reason?: string }> {
  if (!msg.phone) return { queued: false, reason: "sem telefone" };
  // SAIR / VOLTAR de quem não é cliente: para (ou volta a) receber mensagens nossas
  // chat do app: quem escreve é sempre a própria pessoa logada (nunca um estabelecimento ou contato de fora)
  if (msg.channel !== "app") {
    const { handleOptOut } = await import("./outreach.js");
    if (await handleOptOut(msg)) return { queued: false, reason: "SAIR" };
    // resposta de um estabelecimento com quem o assistente está falando por alguém (recado): não vira cliente
    const { handleErrandInbound } = await import("./errands.js");
    if (await handleErrandInbound(msg)) return { queued: false, reason: "recado" };
    // resposta a uma mensagem avulsa (send_whatsapp): volta para quem mandou, sem cadastro
    const { handleDirectReply } = await import("./direct.js");
    if (await handleDirectReply(msg)) return { queued: false, reason: "resposta de mensagem avulsa" };
  }
  // figurinha de cliente para o assistente não precisa do arquivo (ninguém lê): não vai para o banco
  if (msg.kind === "sticker") msg.media = undefined;
  const user = await upsertUser(msg.phone, msg.pushName);
  const conv = await upsertConversation(user.id, msg.channel, msg.remoteJid);

  // Reação da pessoa: registra na mensagem reagida, não dispara resposta
  if (msg.kind === "reaction") {
    if (msg.reactionTo) {
      await query(
        "UPDATE messages SET meta = meta || jsonb_build_object('user_reaction', $3::text) WHERE conversation_id = $1 AND external_id = $2",
        [conv.id, msg.reactionTo, msg.text],
      );
    }
    return { queued: false, reason: "reação" };
  }

  // Mensagem repetida (o WhatsApp reentrega às vezes): com o Redis, o banco nem é tocado
  if (msg.externalId && (await markSeen(`${msg.channel}:${msg.externalId}`, 48 * 3600)) === false) return { queued: false, reason: "duplicada" };

  // Resposta a convite (SIM/NÃO) é tratada aqui mesmo, sem IA
  if (msg.kind === "text") {
    const channel = getChannel(msg.channel);
    if (await handleInviteReply({ user, text: msg.text, channel, remoteJid: msg.remoteJid })) return { queued: false, reason: "convite" };
  }
  if (user.status !== "active") {
    // quem chega de fora sem ser cliente não fica no vácuo: mensagem fixa para assinar (sem IA, uma vez por semana)
    if (user.status === "pending") {
      const { noticeStranger } = await import("./outreach.js");
      if (await noticeStranger(msg, (await getSettings()).strangerMessage)) return { queued: false, reason: "convite para assinar" };
    }
    return { queued: false, reason: `contato ${user.status}` };
  }
  // "apague todos os meus dados" (LGPD): tratado aqui, sem IA
  if (msg.kind === "text") {
    const { handleEraseRequest } = await import("./privacy.js");
    if (await handleEraseRequest({ user, text: msg.text, channel: getChannel(msg.channel), remoteJid: msg.remoteJid })) return { queued: false, reason: "exclusão de dados" };
  }

  // código da Uber (só dígitos) enquanto o robô espera: vai direto para ele, sem IA e sem ficar na conversa
  if (msg.kind === "text" && /^\s*\d{4,6}\s*$/.test(msg.text ?? "")) {
    const { handleUberCode } = await import("./uber.js");
    if (await handleUberCode(user.id, msg.text)) {
      if (msg.externalId) getChannel(msg.channel).react(msg.remoteJid, msg.externalId, "👍").catch(() => {});
      return { queued: false, reason: "código da Uber" };
    }
  }

  // "para" / "cancela" enquanto o assistente ainda trabalha: para a execução na hora (não espera a fila)
  if (msg.kind === "text") {
    const { isStopCommand, stopConversationRuns } = await import("./agent/stop.js");
    if (isStopCommand(msg.text) && (await stopConversationRuns(conv.id)) > 0) {
      if (msg.externalId) getChannel(msg.channel).react(msg.remoteJid, msg.externalId, "👍").catch(() => {});
      return { queued: false, reason: "parar execução" };
    }
  }

  const inserted = await one(
    `INSERT INTO messages (conversation_id, role, content, external_id, media, meta, created_at)
     VALUES ($1, 'user', $2, $3, $4, $5, $6)
     ON CONFLICT (conversation_id, external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING id`,
    [conv.id, msg.text, msg.externalId, msg.media ?? null, { kind: msg.kind, quoted: msg.quoted ?? null, ...(msg.forwarded ? { forwarded: true } : {}), fileName: msg.media?.fileName ?? null }, msg.timestamp],
  );
  if (!inserted) return { queued: false, reason: "duplicada" };
  await query(
    "INSERT INTO usage_daily (user_id, day, messages) VALUES ($1, current_date, 1) ON CONFLICT (user_id, day) DO UPDATE SET messages = usage_daily.messages + 1",
    [user.id],
  );

  const settings = await getSettings();
  // Ritmo: quem manda mensagem demais por minuto (spam, robô, loop) recebe no máximo uma resposta por minuto,
  // com tudo junto. Nada se perde: as mensagens ficam guardadas e entram no próximo processamento.
  let delay = config.MESSAGE_DEBOUNCE_SECONDS;
  let throttled = false;
  if (!isOwner(msg.phone)) {
    const n =
      (await countInWindow(`conv:${conv.id}`, 60)) ??
      (await one("SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1 AND role = 'user' AND created_at > now() - interval '1 minute'", [conv.id])).n;
    if (n > settings.rateLimitPerMinute) {
      delay = Math.max(delay, 60);
      throttled = true;
    }
  }

  const boss = await getBoss();
  // Fila com policy "short": no máximo 1 job aguardando por conversa. Mensagens que chegam
  // dentro da janela entram no mesmo processamento, como alguém que lê tudo antes de responder.
  // O job expira um pouco depois do tempo máximo de execução, para nunca ficar preso.
  await boss.send(
    QUEUES.process,
    { conversationId: conv.id },
    { singletonKey: conv.id, startAfter: delay, retryLimit: 1, retryDelay: 15, priority: 10, expireInSeconds: Math.ceil(settings.maxExecutionMinutes * 60) + 120 },
  );
  return { queued: true, reason: throttled ? "ritmo alto: resposta segurada" : undefined };
}
