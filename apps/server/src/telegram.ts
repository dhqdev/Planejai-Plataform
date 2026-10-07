import { createHmac, randomBytes } from "node:crypto";
import { normalizePhone } from "./accounts.js";
import { telegram } from "./channels/index.js";
import { config } from "./config.js";
import { many, one, query } from "./db/pool.js";
import { emitEvent } from "./events.js";
import { ingest, isOwner, phoneVariants, upsertConversation } from "./ingest.js";
import { rawCredentials, saveCredentials } from "./integrations/registry.js";

/**
 * Telegram: o mesmo assistente do WhatsApp, num bot do dono. Para o bot saber quem é quem, a pessoa liga a conta:
 * pelo painel (Minha conta > Conexões abre t.me/bot?start=CODIGO) ou mandando o próprio contato no bot,
 * que confere o número com o cadastro. Sem ligação, o bot só explica como conectar (nada de IA, nada de custo).
 */

const webhookSecret = () => createHmac("sha256", config.APP_SECRET).update("telegram-webhook").digest("hex").slice(0, 48);
const useWebhook = () => config.PUBLIC_URL.startsWith("https://");

export function telegramSecretOk(header: unknown) {
  return header === webhookSecret();
}

/** Depois de salvar o token: descobre o @ do bot e liga o webhook (ou deixa o worker buscar as mensagens). */
export async function setupTelegram() {
  const me = await telegram.call("getMe", {});
  await saveCredentials("telegram", { username: me.username });
  if (useWebhook()) {
    await telegram.call("setWebhook", {
      url: `${config.PUBLIC_URL.replace(/\/$/, "")}/webhooks/telegram`,
      secret_token: webhookSecret(),
      allowed_updates: ["message"],
      drop_pending_updates: false,
    });
  } else {
    await telegram.call("deleteWebhook", {});
  }
  await telegram.call("setMyCommands", { commands: [{ command: "start", description: "Conectar ou ver se está conectado" }] }).catch(() => {});
  return `Bot @${me.username} pronto${useWebhook() ? "" : " (recebendo mensagens pelo worker, sem webhook)"}`;
}

export async function botUsername() {
  return (await rawCredentials("telegram")).username ?? null;
}

/** Link de uso único (15 min) para a pessoa abrir o bot já conectada. */
export async function telegramLink(userId: string) {
  const username = await botUsername();
  if (!username) throw new Error("O Telegram ainda não foi configurado pelo dono");
  const code = randomBytes(9).toString("base64url");
  await query("DELETE FROM link_codes WHERE expires_at < now()");
  await query("INSERT INTO link_codes (code, user_id, channel, expires_at) VALUES ($1, $2, 'telegram', now() + interval '15 minutes')", [code, userId]);
  return { url: `https://t.me/${username}?start=${code}`, bot: username };
}

export async function connections(userId: string) {
  return many("SELECT channel, external_id, username, created_at FROM channel_links WHERE user_id = $1 ORDER BY created_at", [userId]);
}

export async function unlink(userId: string, channel: string) {
  await query("DELETE FROM channel_links WHERE user_id = $1 AND channel = $2", [userId, channel]);
  await query("DELETE FROM conversations WHERE user_id = $1 AND channel = $2", [userId, channel]);
}

async function link(chatId: string, userId: string, username?: string) {
  // uma conta do Telegram por pessoa: ligar de novo troca a anterior
  await query("DELETE FROM channel_links WHERE channel = 'telegram' AND (user_id = $1 OR external_id = $2)", [userId, chatId]);
  await query("INSERT INTO channel_links (channel, external_id, user_id, username) VALUES ('telegram', $1, $2, $3)", [chatId, userId, username ?? null]);
  await upsertConversation(userId, "telegram", chatId);
  void emitEvent("telegram.linked", { user_id: userId, username: username ?? null });
}

const shareKeyboard = {
  keyboard: [[{ text: "Compartilhar meu número", request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

/** Trata um update do Telegram: ligação de conta ou mensagem para o assistente. */
export async function handleTelegramUpdate(update: any) {
  const msgs = telegram.parseWebhook(update);
  for (const m of msgs) {
    const msg = update.message;
    const chatId = m.remoteJid;
    const username = msg.from?.username ?? m.pushName;

    if (/^\/start\b/.test(m.text)) {
      const code = m.text.split(/\s+/)[1];
      if (code) {
        const row = await one("DELETE FROM link_codes WHERE code = $1 AND channel = 'telegram' AND expires_at > now() RETURNING user_id", [code]);
        if (row) {
          await link(chatId, row.user_id, username);
          const u = await one("SELECT name, full_name FROM users WHERE id = $1", [row.user_id]);
          const first = String(u?.full_name || u?.name || "").split(" ")[0];
          await telegram.sendText(chatId, `Pronto${first ? `, ${first}` : ""}! Agora é só falar comigo por aqui, do mesmo jeito que no WhatsApp.`);
          continue;
        }
        await telegram.sendText(chatId, "Esse link de conexão expirou. Gere outro em Minha conta > Conexões, no painel.");
        continue;
      }
      const linked = await one("SELECT 1 FROM channel_links WHERE channel = 'telegram' AND external_id = $1", [chatId]);
      if (linked) {
        await telegram.sendText(chatId, "Você já está conectado. Pode mandar o que precisar.");
        continue;
      }
      await telegram.call("sendMessage", {
        chat_id: chatId,
        text: "Oi! Sou o assistente do Planejai. Para eu saber quem é você, toque em Compartilhar meu número (o mesmo do WhatsApp) ou use o botão Conectar Telegram no painel.",
        reply_markup: shareKeyboard,
      });
      continue;
    }

    // contato compartilhado: só vale o da própria pessoa
    if (msg.contact) {
      if (String(msg.contact.user_id ?? "") !== String(msg.from?.id)) {
        await telegram.sendText(chatId, "Preciso do seu próprio número: toque no botão Compartilhar meu número.");
        continue;
      }
      const phone = normalizePhone(msg.contact.phone_number);
      const user = await one("SELECT * FROM users WHERE phone = ANY($1) ORDER BY status = 'active' DESC LIMIT 1", [phoneVariants(phone)]);
      if (user && (user.status === "active" || isOwner(phone))) {
        await link(chatId, user.id, username);
        await telegram.call("sendMessage", {
          chat_id: chatId,
          text: `Conectado! Pode falar comigo por aqui, do mesmo jeito que no WhatsApp.`,
          reply_markup: { remove_keyboard: true },
        });
      } else {
        await telegram.call("sendMessage", {
          chat_id: chatId,
          text: "Esse número ainda não usa o Planejai. A entrada é por convite: peça para quem te indicou mandar um.",
          reply_markup: { remove_keyboard: true },
        });
      }
      continue;
    }

    const linked = await one(
      "SELECT u.phone FROM channel_links l JOIN users u ON u.id = l.user_id WHERE l.channel = 'telegram' AND l.external_id = $1",
      [chatId],
    );
    if (!linked) {
      await telegram.call("sendMessage", {
        chat_id: chatId,
        text: "Antes de começar, preciso saber quem é você: toque em Compartilhar meu número.",
        reply_markup: shareKeyboard,
      });
      continue;
    }
    m.phone = linked.phone;
    await ingest(m);
  }
}

/**
 * Sem URL https pública (dev, rede interna), o worker busca as mensagens no Telegram (long polling).
 * Com https, o Telegram chama /webhooks/telegram e isto fica parado.
 */
export function startTelegramPolling(log: { info: (...a: any[]) => void; error: (...a: any[]) => void }) {
  if (useWebhook()) return;
  let offset = 0;
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        if (!(await telegram.ready())) {
          await new Promise((r) => setTimeout(r, 30_000));
          continue;
        }
        const updates: any[] = await telegram.call("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, 35_000);
        for (const u of updates) {
          offset = u.update_id + 1;
          await handleTelegramUpdate(u).catch((err) => log.error({ err }, "falha ao tratar update do Telegram"));
        }
      } catch (err) {
        log.error({ err: (err as Error).message }, "Telegram: falha ao buscar mensagens");
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  };
  void loop();
  log.info("Telegram: buscando mensagens pelo worker (sem webhook)");
  return () => {
    stopped = true;
  };
}
