import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { one, query } from "../db/pool.js";
import { safeFetch } from "../net.js";
import type { Channel, InboundMessage, OutboundImage } from "./types.js";

const run = promisify(execFile);

/** Arquivo maior que isto não fica guardado no chat do app (aparece só o nome). */
const MAX_DATA_BYTES = 12 * 1024 * 1024;

/** Endereço da conversa do app: um por pessoa. */
export const appJid = (userId: string) => `app:${userId}`;
const userOf = (jid: string) => (jid.startsWith("app:") ? jid.slice(4) : null);

/**
 * Converte áudio para MP3 com o ffmpeg (Ogg/Opus do assistente não toca em todo iPhone; WebM do Chrome não é
 * aceito pelo transcritor). Sem ffmpeg devolve null e quem chamou segue com o original.
 */
export async function toMp3(base64: string, ext: string): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "pj-app-"));
  try {
    const src = join(dir, `in.${ext}`);
    const out = join(dir, "out.mp3");
    await writeFile(src, Buffer.from(base64, "base64"));
    await run("ffmpeg", ["-v", "error", "-y", "-i", src, "-vn", "-ac", "1", "-b:a", "64k", out], { timeout: 30_000 });
    return (await readFile(out)).toString("base64");
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function saveAppMessage(userId: string, m: { role: "user" | "assistant"; text?: string | null; media?: Record<string, unknown> | null; data?: string | null; externalId?: string | null }) {
  const data = m.data && Buffer.byteLength(m.data, "base64") <= MAX_DATA_BYTES ? m.data : null;
  return one<{ id: string }>(
    "INSERT INTO app_chat (user_id, role, text, media, data, external_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [userId, m.role, m.text ?? null, m.media ?? null, data, m.externalId ?? null],
  );
}

/**
 * Canal do app (aba Início no celular): o mesmo motor do WhatsApp, mas o que seria enviado fica guardado em
 * app_chat para a tela mostrar. Grava direto no banco, então funciona em qualquer ROLE (api, worker, conversations).
 * Sem enquete: o "sim" vai em texto e a tela mostra os botões Sim/Não.
 */
export class AppChannel implements Channel {
  id = "app";
  configured() {
    return true;
  }
  parseWebhook(): InboundMessage[] {
    return [];
  }
  async downloadMedia(msg: InboundMessage) {
    return msg.media?.base64 ? { base64: msg.media.base64, mimetype: msg.media.mimetype } : null;
  }
  async sendText(to: string, text: string) {
    const uid = userOf(to);
    if (!uid) throw new Error("conversa do app sem pessoa");
    const externalId = `app-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await saveAppMessage(uid, { role: "assistant", text, externalId });
    await this.stopTyping(uid);
    return { id: externalId };
  }
  async sendImage(to: string, image: OutboundImage) {
    const uid = userOf(to);
    if (!uid) throw new Error("conversa do app sem pessoa");
    let data = image.base64 ?? null;
    let mimetype = image.mimetype ?? null;
    if (!data && image.url) {
      const r = await safeFetch(image.url).catch(() => null);
      if (r?.ok) {
        data = Buffer.from(await r.arrayBuffer()).toString("base64");
        mimetype = mimetype ?? r.headers.get("content-type");
      }
    }
    const kind = image.kind ?? "image";
    // voz do assistente vem em Ogg/Opus (formato do WhatsApp): MP3 toca em qualquer navegador
    if (kind === "audio" && data && /ogg|opus/.test(mimetype ?? "")) {
      const mp3 = await toMp3(data, "ogg");
      if (mp3) (data = mp3), (mimetype = "audio/mpeg");
    }
    const externalId = `app-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await saveAppMessage(uid, {
      role: "assistant",
      text: image.caption ?? null,
      media: { kind, mimetype: mimetype ?? "application/octet-stream", fileName: image.fileName ?? null, seconds: image.seconds ?? null, gif: image.gif ?? false, spoken: image.spoken ?? null },
      data,
      externalId,
    });
    await this.stopTyping(uid);
    return { id: externalId };
  }
  async react(to: string, messageId: string, emoji: string) {
    const uid = userOf(to);
    if (uid) await query("UPDATE app_chat SET reaction = $3 WHERE user_id = $1 AND external_id = $2", [uid, messageId, emoji]);
  }
  async setTyping(to: string, ms: number, kind: "typing" | "recording" = "typing") {
    const uid = userOf(to);
    if (!uid) return;
    await query(
      `INSERT INTO app_chat_state (user_id, typing_until, typing_kind) VALUES ($1, now() + make_interval(secs => $2), $3)
       ON CONFLICT (user_id) DO UPDATE SET typing_until = EXCLUDED.typing_until, typing_kind = EXCLUDED.typing_kind`,
      [uid, Math.max(1, ms / 1000), kind],
    );
  }
  async markRead() {}
  private async stopTyping(uid: string) {
    await query("UPDATE app_chat_state SET typing_until = NULL WHERE user_id = $1", [uid]).catch(() => {});
  }
}

export const appChannel = new AppChannel();
