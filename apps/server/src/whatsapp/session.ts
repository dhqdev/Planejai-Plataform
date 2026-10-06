import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WAMessage,
  type WASocket,
} from "baileys";
import type pg from "pg";
import pino from "pino";
import QRCode from "qrcode";
import { parseWAMessage } from "../channels/wa-message.js";
import { pool, query } from "../db/pool.js";
import { ingest } from "../ingest.js";
import { clearAuthState, usePgAuthState } from "./auth-state.js";

export const SESSION_ID = "default";
const LOCK_KEY = 727275;
const MEDIA_MAX_BYTES = 20 * 1024 * 1024;

type Status = "disconnected" | "connecting" | "qr" | "pairing" | "connected";
type Log = { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };

export interface WaCommand {
  action: "connect" | "logout" | "restart";
  /** quando informado, conecta por código de pareamento em vez de QR */
  phone?: string;
}

async function setStatus(status: Status, patch: { qr?: string | null; pairing_code?: string | null; phone?: string | null; name?: string | null; last_error?: string | null } = {}) {
  await query(
    `UPDATE wa_sessions SET status = $2, qr = $3, pairing_code = $4,
       phone = COALESCE($5, phone), name = COALESCE($6, name), last_error = $7, updated_at = now() WHERE id = $1`,
    [SESSION_ID, status, patch.qr ?? null, patch.pairing_code ?? null, patch.phone ?? null, patch.name ?? null, patch.last_error ?? null],
  );
}

/**
 * Conexão própria com o WhatsApp via Baileys (WhatsApp Web multi-device), no estilo do tekvosoft:
 * a sessão fica no Postgres, o QR/código de pareamento aparece no dashboard e a conexão se
 * recupera sozinha de quedas. Só um processo da stack segura a conexão (advisory lock).
 */
class WhatsAppSession {
  sock: WASocket | null = null;
  private log: Log = console;
  private lockClient: pg.PoolClient | null = null;
  private listenClient: pg.PoolClient | null = null;
  private retries = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pairPhone: string | null = null;
  private stopping = false;

  get connected() {
    return Boolean(this.sock?.user);
  }

  async start(log: Log) {
    this.log = log;
    if (!(await this.acquireLock())) {
      log.info("outro processo já segura a conexão do WhatsApp; tentando de novo em 30s");
      setTimeout(() => void this.start(log), 30_000).unref();
      return;
    }
    // Comandos do dashboard (API) chegam por LISTEN/NOTIFY
    this.listenClient = await pool.connect();
    this.listenClient.on("notification", (msg) => {
      if (msg.channel !== "wa_command" || !msg.payload) return;
      void this.handleCommand(JSON.parse(msg.payload) as WaCommand).catch((err) => this.log.error({ err }, "falha no comando do WhatsApp"));
    });
    await this.listenClient.query("LISTEN wa_command");

    // Só reconecta sozinho se já foi pareado; QR novo só quando alguém pede no dashboard
    const { state } = await usePgAuthState(SESSION_ID);
    if (state.creds.registered) await this.connect();
    else await setStatus("disconnected");
    log.info("gerenciador do WhatsApp (Baileys) iniciado");
  }

  private async acquireLock() {
    const client = await pool.connect();
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY]);
    if (rows[0]?.ok) {
      this.lockClient = client;
      return true;
    }
    client.release();
    return false;
  }

  async handleCommand(cmd: WaCommand) {
    this.log.info({ action: cmd.action }, "comando do WhatsApp");
    if (cmd.action === "logout") {
      await this.sock?.logout().catch(() => {});
      await this.teardown();
      await clearAuthState(SESSION_ID);
      await setStatus("disconnected", { phone: null });
      await query("UPDATE wa_sessions SET phone = NULL, name = NULL WHERE id = $1", [SESSION_ID]);
      return;
    }
    if (cmd.action === "connect" && cmd.phone) this.pairPhone = cmd.phone.replace(/\D/g, "");
    await this.teardown();
    this.retries = 0;
    await this.connect();
  }

  private async teardown() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const s = this.sock;
    this.sock = null;
    if (s) {
      s.ev.removeAllListeners("connection.update");
      s.ev.removeAllListeners("creds.update");
      s.ev.removeAllListeners("messages.upsert");
      s.end(undefined);
    }
  }

  private async connect() {
    await setStatus("connecting");
    const { state, saveCreds } = await usePgAuthState(SESSION_ID);
    const logger = pino({ level: "warn" });
    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      version = undefined;
    }

    const sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      version,
      logger,
      browser: Browsers.macOS("Desktop"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;
    let pairingRequested = false;
    let progressed = false;

    // Se o servidor do WhatsApp não responder (rede bloqueada, DNS), não fica preso em "conectando"
    const watchdog = setTimeout(() => {
      if (this.sock !== sock || progressed) return;
      this.log.warn("WhatsApp não respondeu em 45s; tentando de novo");
      void this.teardown().then(async () => {
        const delay = Math.min(60_000, 5000 * 2 ** this.retries++);
        await setStatus("connecting", { last_error: "O servidor do WhatsApp não respondeu. Verifique a internet do servidor; tentando de novo." });
        this.reconnectTimer = setTimeout(() => void this.connect().catch((err) => this.log.error({ err }, "falha ao reconectar")), delay);
      });
    }, 45_000);
    watchdog.unref();

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (this.sock !== sock) return;
      if (qr || connection === "open" || connection === "close") {
        progressed = true;
        clearTimeout(watchdog);
      }
      try {
        if (qr) {
          if (this.pairPhone && !pairingRequested) {
            pairingRequested = true;
            const code = await sock.requestPairingCode(this.pairPhone);
            this.pairPhone = null;
            await setStatus("pairing", { pairing_code: code });
          } else if (!pairingRequested) {
            await setStatus("qr", { qr: await QRCode.toDataURL(qr, { margin: 1, width: 320 }) });
          }
        }
        if (connection === "open") {
          this.retries = 0;
          const phone = sock.user?.id?.split(":")[0]?.split("@")[0] ?? null;
          await setStatus("connected", { phone, name: sock.user?.name ?? null });
          this.log.info({ phone }, "WhatsApp conectado");
        }
        if (connection === "close") {
          const code = (lastDisconnect?.error as any)?.output?.statusCode as number | undefined;
          const reason = lastDisconnect?.error?.message ?? "conexão fechada";
          this.sock = null;
          if (this.stopping) return;
          if (code === DisconnectReason.loggedOut || code === 403) {
            this.log.warn("WhatsApp desconectado pelo celular; limpando a sessão");
            await clearAuthState(SESSION_ID);
            await setStatus("disconnected", { last_error: "Sessão encerrada no celular. Conecte de novo." });
            return;
          }
          if (!sock.authState.creds.registered && code === DisconnectReason.timedOut) {
            await setStatus("disconnected", { last_error: "O QR code expirou. Gere outro para conectar." });
            return;
          }
          const delay = code === DisconnectReason.restartRequired ? 500 : Math.min(60_000, 2000 * 2 ** this.retries++);
          this.log.warn({ code, reason, delay }, "WhatsApp caiu; reconectando");
          await setStatus("connecting", { last_error: `${reason} (código ${code ?? "?"})` });
          this.reconnectTimer = setTimeout(() => void this.connect().catch((err) => this.log.error({ err }, "falha ao reconectar")), delay);
        }
      } catch (err) {
        this.log.error({ err }, "erro tratando atualização de conexão");
        await setStatus("disconnected", { last_error: (err as Error).message }).catch(() => {});
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const raw of messages) {
        try {
          await this.handleIncoming(sock, raw);
        } catch (err) {
          this.log.error({ err }, "falha ao processar mensagem recebida");
        }
      }
    });
  }

  private async handleIncoming(sock: WASocket, raw: WAMessage) {
    const msg = parseWAMessage(raw, "baileys");
    if (!msg) return;
    // Baixa áudio e foto já na chegada (a mídia do WhatsApp expira e o socket só existe aqui)
    if (msg.media && (msg.kind === "audio" || msg.kind === "image")) {
      try {
        const buf = await downloadMediaMessage(raw, "buffer", {}, { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage });
        if (buf.length <= MEDIA_MAX_BYTES) msg.media.base64 = buf.toString("base64");
      } catch (err) {
        this.log.warn({ err }, "não consegui baixar a mídia");
      }
    }
    await ingest(msg);
  }

  async stop() {
    this.stopping = true;
    await this.teardown();
    if (this.listenClient) {
      await this.listenClient.query("UNLISTEN wa_command").catch(() => {});
      this.listenClient.release();
    }
    if (this.lockClient) {
      await this.lockClient.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
      this.lockClient.release();
    }
  }
}

export const whatsapp = new WhatsAppSession();

/** Usado pela API: manda um comando para o processo que segura a conexão. */
export async function sendWaCommand(cmd: WaCommand) {
  await query("SELECT pg_notify('wa_command', $1)", [JSON.stringify(cmd)]);
}
