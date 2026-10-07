import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type AuthenticationCreds,
  type WAMessage,
  type WASocket,
} from "baileys";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type pg from "pg";
import pino from "pino";
import QRCode from "qrcode";
import { parseWAMessage } from "../channels/wa-message.js";
import { pool, query } from "../db/pool.js";
import { ingest } from "../ingest.js";
import { notify } from "../notifications.js";
import { clearAuthState, usePgAuthState } from "./auth-state.js";

export const SESSION_ID = "default";
const MEDIA_MAX_BYTES = 20 * 1024 * 1024;

type Status = "disconnected" | "connecting" | "reconnecting" | "qr" | "pairing" | "connected";
type Log = { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };
type SocketConfig = Parameters<typeof makeWASocket>[0];

export interface WaCommand {
  action: "connect" | "logout" | "restart";
  /** quando informado, conecta por código de pareamento em vez de QR */
  phone?: string;
}

/** Tempos da conexão. Os padrões valem para produção; os testes encurtam. */
export interface WaTimings {
  /** renova o aluguel e confere a saúde do socket */
  heartbeatMs: number;
  /** validade do aluguel: se o processo morrer sem avisar, outro assume depois disso */
  leaseSeconds: number;
  /** ping do próprio Baileys; sem resposta em keepAlive+5s ele fecha com connectionLost */
  keepAliveMs: number;
  /** conexão aberta sem receber NADA do servidor por esse tempo = socket meio-aberto: derruba e religa */
  staleMs: number;
  /** sem QR nem conexão aberta nesse tempo = servidor não respondeu: tenta de novo */
  openTimeoutMs: number;
  /** espera entre tentativas: base * 2^tentativa, até o máximo (nunca desiste) */
  backoffBaseMs: number;
  backoffMaxMs: number;
}

const DEFAULT_TIMINGS: WaTimings = {
  heartbeatMs: 15_000,
  leaseSeconds: 45,
  keepAliveMs: 20_000,
  staleMs: 90_000,
  openTimeoutMs: 45_000,
  backoffBaseMs: 2_000,
  backoffMaxMs: 60_000,
};

/** Nome legível de cada DisconnectReason do Baileys, para o log dizer por que caiu. */
const REASON_NAMES: Record<number, string> = {
  [DisconnectReason.connectionClosed]: "connectionClosed",
  [DisconnectReason.connectionLost]: "connectionLost/timedOut",
  [DisconnectReason.connectionReplaced]: "connectionReplaced",
  [DisconnectReason.loggedOut]: "loggedOut",
  [DisconnectReason.forbidden]: "forbidden",
  [DisconnectReason.badSession]: "badSession",
  [DisconnectReason.restartRequired]: "restartRequired",
  [DisconnectReason.multideviceMismatch]: "multideviceMismatch",
  [DisconnectReason.unavailableService]: "unavailableService",
};

/**
 * Já foi pareado? `creds.registered` NÃO serve: o Baileys só marca registered no pareamento por código;
 * quem conectou pelo QR fica com registered=false para sempre. O que prova o pareamento é a conta
 * assinada (account) que o WhatsApp devolve no pair-success, junto do me.id.
 */
export function isPaired(creds: Partial<AuthenticationCreds> | null | undefined) {
  return Boolean(creds?.account && creds?.me?.id);
}

function statusCodeOf(err: unknown): number | undefined {
  return (err as any)?.output?.statusCode;
}

/** Erro de envio que significa "o socket morreu por baixo" (vale derrubar, religar e tentar de novo). */
export function isConnectionError(err: unknown) {
  const code = statusCodeOf(err);
  if (code !== undefined && [428, 408, 440, 503].includes(code)) return true;
  // só erros do próprio socket do Baileys: falha ao baixar a mídia de uma URL não derruba a conexão
  return /^connection (closed|terminated|was lost|failure)/i.test((err as Error)?.message ?? "");
}

/**
 * Conexão própria com o WhatsApp via Baileys (WhatsApp Web multi-device), no estilo do tekvosoft:
 * a sessão fica no Postgres, o QR/código de pareamento aparece no dashboard e a conexão se
 * recupera sozinha de quedas. Só um processo da stack segura a conexão: ele "aluga" a sessão no banco
 * e renova a cada 15s. Se o processo morrer sem avisar (container derrubado no redeploy), o aluguel vence
 * em 45s e o worker novo assume sozinho.
 *
 * Religação: qualquer queda de uma sessão pareada vira "reconectando" no painel e uma nova tentativa com
 * espera crescente (2s, 4s, 8s... até 60s) que nunca desiste. Só loggedOut/forbidden (o celular removeu o
 * aparelho) limpa as credenciais e pede QR novo. A cada batida (15s) um vigia confere se o socket ainda
 * recebe tráfego; conexão meio-aberta (sem close nem resposta) é derrubada e religada.
 */
export class WhatsAppSession {
  sock: WASocket | null = null;
  /** só vira true no connection 'open' (sock.user já vem das credenciais antes de abrir) */
  private open = false;
  /** credenciais desta sessão já pareadas (ver isPaired) */
  private paired = false;
  private log: Log = console;
  private holding = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private beating = false;
  /** conexões em montagem (entre o connect() começar e o socket existir) */
  private connecting = 0;
  private listenClient: pg.PoolClient | null = null;
  private retries = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private openTimer: NodeJS.Timeout | null = null;
  /** muda a cada socket novo/derrubado: uma conexão antiga em andamento desiste sozinha */
  private epoch = 0;
  private lastRecvAt = 0;
  private lastLeaseOkAt = 0;
  private pairPhone: string | null = null;
  private stopping = false;
  private waiters = new Set<() => void>();
  /** gravações de status/credenciais em fila, na ordem em que aconteceram */
  private statusChain: Promise<unknown> = Promise.resolve();
  private saving: Promise<unknown> = Promise.resolve();
  private version: [number, number, number] | undefined;
  private waitingLogged = false;

  private readonly holder: string;
  private readonly t: WaTimings;
  private readonly makeSocket: (cfg: SocketConfig) => WASocket;
  private readonly fetchVersion: () => Promise<[number, number, number] | undefined>;

  constructor(
    opts: {
      holder?: string;
      timings?: Partial<WaTimings>;
      makeSocket?: (cfg: SocketConfig) => WASocket;
      fetchVersion?: () => Promise<[number, number, number] | undefined>;
    } = {},
  ) {
    this.holder = opts.holder ?? `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
    this.t = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.makeSocket = opts.makeSocket ?? ((cfg) => makeWASocket(cfg));
    this.fetchVersion = opts.fetchVersion ?? (async () => (await fetchLatestBaileysVersion()).version);
  }

  /** Conectado de verdade: socket aberto e logado (não basta ter sock.user). */
  get connected() {
    return Boolean(this.open && this.sock?.user);
  }

  /** Este processo segura o aluguel da conexão agora? */
  get holdsLease() {
    return this.holding;
  }

  async start(log: Log) {
    this.log = log;
    if (this.stopping || this.heartbeat) return;
    // A batida assume o aluguel quando ele estiver livre, religa o que caiu e solta se outro processo assumir
    this.heartbeat = setInterval(() => void this.beat().catch((err) => this.log.warn({ err }, "falha no sinal do WhatsApp")), this.t.heartbeatMs);
    this.heartbeat.unref();
    await this.beat().catch((err) => this.log.warn({ err }, "falha no sinal do WhatsApp"));
    log.info("gerenciador do WhatsApp (Baileys) iniciado");
  }

  /** Assume a conexão se ninguém estiver com ela ou se o aluguel do outro processo venceu. */
  private async acquireLease() {
    const r = await query(
      `UPDATE wa_sessions SET holder = $2, lease_until = now() + make_interval(secs => $3), heartbeat_at = now()
        WHERE id = $1 AND (holder IS NULL OR holder = $2 OR lease_until IS NULL OR lease_until < now()) RETURNING id`,
      [SESSION_ID, this.holder, this.t.leaseSeconds],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * A cada 15s: renova o aluguel (mostra no painel que está escutando), assume a conexão se ela ficou livre,
   * solta se outro processo assumiu e confere se o socket ainda está vivo.
   */
  private async beat() {
    if (this.stopping || this.beating) return;
    this.beating = true;
    try {
      let got: boolean;
      try {
        got = await this.acquireLease();
        this.lastLeaseOkAt = Date.now();
      } catch (err) {
        // Banco fora: mantém a conexão enquanto o aluguel ainda vale; depois dele outro processo pode assumir
        if (this.holding && Date.now() - this.lastLeaseOkAt > this.t.leaseSeconds * 1000) {
          this.log.warn("sem renovar o aluguel do WhatsApp até ele vencer; soltando a conexão daqui até o banco voltar");
          this.suspend();
        }
        throw err;
      }
      if (!got) {
        if (this.holding) {
          this.log.warn("outro processo assumiu o WhatsApp; soltando a conexão daqui");
          this.suspend();
        } else if (!this.waitingLogged) {
          this.waitingLogged = true;
          this.log.info(`outro processo está com a conexão do WhatsApp; tento assumir de novo a cada ${Math.round(this.t.heartbeatMs / 1000)}s`);
        }
        return;
      }
      this.waitingLogged = false;
      // Sem LISTEN os comandos do painel não chegam, mas a conexão não pode esperar por isso
      await this.ensureListening().catch((err) => this.log.warn({ err }, "não consegui escutar os comandos do painel (wa_command); tento de novo na próxima batida"));
      if (!this.holding) {
        this.holding = true;
        this.retries = 0;
        await this.saving;
        const { state } = await usePgAuthState(SESSION_ID);
        this.paired = isPaired(state.creds);
        // Só reconecta sozinho se já foi pareado; QR novo só quando alguém pede no dashboard
        if (this.paired) {
          this.log.info("aluguel do WhatsApp assumido; conectando com a sessão salva");
          await this.connect("connecting");
        } else {
          await this.setStatus("disconnected", {}, "clear");
        }
        return;
      }
      await this.watchdog();
    } finally {
      this.beating = false;
    }
  }

  /** Vigia: conexão sumida sem aviso ou meio-aberta (sem tráfego) é derrubada e religada. */
  private async watchdog() {
    if (this.reconnectTimer || this.connecting || this.stopping) return; // religação já agendada ou em andamento
    const sock = this.sock;
    if (!sock) {
      if (!this.paired) {
        await this.saving;
        this.paired = isPaired((await usePgAuthState(SESSION_ID)).state.creds);
      }
      if (this.paired) this.scheduleReconnect("nenhum socket aberto (a conexão sumiu sem aviso)", { immediate: true });
      return;
    }
    if (!this.open) return; // abrindo: o openTimer cuida de quem não responde
    const wsOpen = (sock.ws as any)?.isOpen !== false;
    const idle = Date.now() - this.lastRecvAt;
    if (!wsOpen || idle > this.t.staleMs) {
      const reason = !wsOpen ? "websocket fechado sem evento de close" : `socket mudo há ${Math.round(idle / 1000)}s (meio-aberto, sem resposta ao ping)`;
      this.dropSocket();
      this.scheduleReconnect(reason, { immediate: true });
      return;
    }
    // Conectado: mantém o painel certo (ex.: alguém gravou 'connecting' pela API e o comando não mudou nada)
    await this.queueStatus(() =>
      query(
        `UPDATE wa_sessions SET status = 'connected', qr = NULL, pairing_code = NULL, last_error = NULL, down_since = NULL, updated_at = now()
          WHERE id = $1 AND status <> 'connected'`,
        [SESSION_ID],
      ),
    );
  }

  /** Perdeu o aluguel: larga o socket (o outro processo cuida do status) e segue tentando reassumir. */
  private suspend() {
    this.holding = false;
    this.dropSocket();
    this.wakeWaiters();
  }

  /** LISTEN wa_command: comandos do dashboard (API). Se a conexão do LISTEN cair, a próxima batida refaz. */
  private async ensureListening() {
    if (this.listenClient) return;
    const client = await pool.connect();
    client.on("error", (err) => {
      this.log.warn({ err }, "conexão do LISTEN wa_command caiu; refaço na próxima batida");
      if (this.listenClient === client) this.listenClient = null;
      client.release(err);
    });
    client.on("notification", (msg) => {
      if (msg.channel !== "wa_command" || !msg.payload) return;
      void this.handleCommand(JSON.parse(msg.payload) as WaCommand).catch((err) => this.log.error({ err }, "falha no comando do WhatsApp"));
    });
    try {
      await client.query("LISTEN wa_command");
    } catch (err) {
      client.release(err as Error);
      throw err;
    }
    this.listenClient = client;
  }

  async handleCommand(cmd: WaCommand) {
    if (!this.holding) return; // quem segura o aluguel é que executa
    this.log.info({ action: cmd.action }, "comando do WhatsApp");
    if (cmd.action === "logout") {
      const s = this.sock;
      this.dropSocket({ end: false });
      if (s) {
        await s.logout().catch(() => {});
        this.endSocket(s);
      }
      await clearAuthState(SESSION_ID);
      this.paired = false;
      this.retries = 0;
      this.wakeWaiters();
      await this.setStatus("disconnected", {}, "clear");
      await query("UPDATE wa_sessions SET phone = NULL, name = NULL WHERE id = $1", [SESSION_ID]);
      return;
    }
    if (cmd.action === "connect" && cmd.phone) this.pairPhone = cmd.phone.replace(/\D/g, "");
    this.retries = 0;
    await this.connect("connecting");
  }

  /** Para o socket atual sem disparar o tratamento de queda dele e cancela timers pendentes. */
  private dropSocket(opts: { end?: boolean } = {}) {
    this.epoch++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = null;
    const s = this.sock;
    this.sock = null;
    this.open = false;
    if (!s) return;
    s.ev.removeAllListeners("connection.update");
    s.ev.removeAllListeners("creds.update");
    s.ev.removeAllListeners("messages.upsert");
    if (opts.end !== false) this.endSocket(s);
  }

  private endSocket(s: WASocket) {
    try {
      void Promise.resolve(s.end(undefined)).catch(() => {});
    } catch {
      /* já fechado */
    }
  }

  /**
   * Agenda uma nova tentativa com espera crescente (nunca desiste). O painel mostra "reconectando"
   * e down_since marca desde quando está caído (o healthcheck usa).
   */
  private scheduleReconnect(reason: string, opts: { code?: number; immediate?: boolean; minDelayMs?: number; lastError?: string } = {}) {
    if (this.stopping || !this.holding) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const attempt = this.retries + 1;
    let delay = opts.immediate ? 0 : Math.min(this.t.backoffMaxMs, this.t.backoffBaseMs * 2 ** this.retries);
    if (delay) delay = Math.round(delay * (0.8 + Math.random() * 0.4)); // espalha para não bater junto
    delay = Math.max(delay, opts.minDelayMs ?? 0);
    if (opts.code !== DisconnectReason.restartRequired) this.retries++;
    const status: Status = this.paired ? "reconnecting" : "connecting";
    const lastError = opts.lastError ?? `${reason}. Reconectando sozinho (tentativa ${attempt}).`;
    this.log.warn({ reason, code: opts.code, attempt, delayMs: delay }, `WhatsApp caiu (${reason}); reconectando em ${Math.round(delay / 1000)}s`);
    void this.setStatus(status, { last_error: lastError }, this.paired ? "set" : "keep").catch((err) => this.log.warn({ err }, "não gravei o status do WhatsApp"));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(status, lastError).catch((err) => {
        this.log.error({ err }, "falha ao reconectar o WhatsApp");
        this.scheduleReconnect(`falha ao reconectar: ${(err as Error).message}`);
      });
    }, delay);
  }

  private async latestVersion() {
    if (this.version) return this.version;
    try {
      this.version = await Promise.race([this.fetchVersion(), new Promise<undefined>((r) => setTimeout(() => r(undefined), 5000).unref())]);
    } catch {
      /* usa a versão embutida no Baileys */
    }
    return this.version;
  }

  private async connect(status: Status = "connecting", lastError?: string) {
    if (this.stopping || !this.holding) return;
    // Nunca dois sockets com a mesma conta: o antigo sai antes (senão o WhatsApp derruba um com connectionReplaced)
    this.dropSocket();
    const epoch = this.epoch;
    let state: Awaited<ReturnType<typeof usePgAuthState>>["state"];
    let saveCreds: () => Promise<void>;
    let version: [number, number, number] | undefined;
    this.connecting++;
    try {
      // "reconectando" mantém desde quando caiu; conexão nova (início, comando do painel) zera o relógio
      await this.setStatus(status, { last_error: lastError ?? null }, status === "reconnecting" ? "set" : "clear");
      await this.saving; // credenciais do socket anterior (ex.: logo depois de ler o QR) já no banco
      ({ state, saveCreds } = await usePgAuthState(SESSION_ID));
      version = await this.latestVersion();
    } finally {
      this.connecting--;
    }
    if (epoch !== this.epoch || this.stopping || !this.holding) return; // outra conexão começou no meio
    this.paired = isPaired(state.creds);

    const logger = pino({ level: "warn" });
    const sock = this.makeSocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      version,
      logger,
      browser: Browsers.macOS("Desktop"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      // ping a cada 20s: NAT/proxy do Swarm costuma matar conexão TCP ociosa sem avisar
      keepAliveIntervalMs: this.t.keepAliveMs,
      connectTimeoutMs: 30_000,
      defaultQueryTimeoutMs: 60_000,
    });
    this.sock = sock;
    this.open = false;
    this.lastRecvAt = Date.now();
    // Qualquer coisa que chega do servidor (inclusive a resposta do ping) prova que o socket está vivo
    sock.ws?.on?.("message", () => {
      if (this.sock === sock) this.lastRecvAt = Date.now();
    });
    let pairingRequested = false;

    // Se o servidor do WhatsApp não responder (rede bloqueada, DNS), não fica preso em "conectando"
    this.openTimer = setTimeout(() => {
      if (this.sock !== sock || this.open) return;
      this.dropSocket();
      this.scheduleReconnect(`o servidor do WhatsApp não respondeu em ${Math.round(this.t.openTimeoutMs / 1000)}s`, {
        lastError: "O servidor do WhatsApp não respondeu. Verifique a internet do servidor; tentando de novo.",
      });
    }, this.t.openTimeoutMs);
    this.openTimer.unref();

    sock.ev.on("creds.update", () => {
      this.saving = this.saving.then(saveCreds).catch((err) => this.log.error({ err }, "falha ao salvar as credenciais do WhatsApp"));
    });

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (this.sock !== sock) return;
      if ((qr || connection === "open" || connection === "close") && this.openTimer) {
        clearTimeout(this.openTimer);
        this.openTimer = null;
      }
      try {
        if (qr) {
          if (this.pairPhone && !pairingRequested) {
            pairingRequested = true;
            const code = await sock.requestPairingCode(this.pairPhone);
            this.pairPhone = null;
            await this.setStatus("pairing", { pairing_code: code });
          } else if (!pairingRequested) {
            await this.setStatus("qr", { qr: await QRCode.toDataURL(qr, { margin: 1, width: 320 }) });
          }
        }
        if (connection === "open") {
          const wasDown = this.retries;
          this.open = true;
          this.paired = true;
          this.retries = 0;
          this.lastRecvAt = Date.now();
          const phone = sock.user?.id?.split(":")[0]?.split("@")[0] ?? null;
          await this.setStatus("connected", { phone, name: sock.user?.name ?? null }, "clear");
          this.log.info({ phone, afterAttempts: wasDown }, "WhatsApp conectado");
          this.wakeWaiters();
        }
        if (connection === "close") this.onClose(sock, lastDisconnect?.error);
      } catch (err) {
        this.log.error({ err }, "erro tratando atualização de conexão");
        // nunca termina sem socket e sem religação agendada
        if (this.sock === sock && connection === "close") this.dropSocket();
        if (!this.sock && this.paired) this.scheduleReconnect(`erro tratando a queda: ${(err as Error).message}`);
        else if (this.sock === sock && qr && !this.paired) {
          // falhou gerar o QR/código de pareamento: mostra o erro e deixa gerar de novo
          this.dropSocket();
          await this.setStatus("disconnected", { last_error: (err as Error).message }, "clear").catch(() => {});
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (this.sock === sock) this.lastRecvAt = Date.now();
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

  /** Decide o que fazer em cada DisconnectReason. Agenda a religação ANTES de gravar no banco. */
  private onClose(sock: WASocket, error: Error | undefined) {
    const code = statusCodeOf(error);
    const message = error?.message ?? "conexão fechada";
    const name = code !== undefined ? REASON_NAMES[code] ?? `código ${code}` : "sem código";
    this.dropSocket({ end: false }); // o Baileys já fechou este
    if (this.stopping || !this.holding) return;
    const pairedNow = this.paired || isPaired(sock.authState?.creds);
    this.paired = pairedNow;

    if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
      this.log.warn({ code, reason: name, message }, "WhatsApp desconectado pelo celular; limpando a sessão (precisa de QR novo)");
      this.paired = false;
      this.retries = 0;
      this.wakeWaiters();
      void (async () => {
        await this.saving;
        await clearAuthState(SESSION_ID);
        await this.setStatus("disconnected", { last_error: "Sessão encerrada no celular. Conecte de novo." }, "clear");
        await notify({ userId: null, kind: "whatsapp", title: "WhatsApp desconectado", body: "A sessão foi encerrada no celular. Gere um QR code novo para religar.", link: "/whatsapp" });
      })().catch((err) => this.log.error({ err }, "falha ao limpar a sessão do WhatsApp"));
      return;
    }

    if (!pairedNow) {
      // Ainda pareando: depois de ler o QR o WhatsApp pede restartRequired e a conexão volta já logada
      if (code === DisconnectReason.restartRequired) {
        this.scheduleReconnect(`${name}: ${message}`, { code, immediate: true });
        return;
      }
      this.log.warn({ code, reason: name, message }, "conexão caiu antes de concluir o pareamento");
      this.wakeWaiters();
      const lastError =
        code === DisconnectReason.timedOut ? "O QR code expirou. Gere outro para conectar." : `A conexão caiu antes de concluir o pareamento (${name}). Gere outro QR code.`;
      void this.setStatus("disconnected", { last_error: lastError }, "clear").catch((err) => this.log.warn({ err }, "não gravei o status do WhatsApp"));
      return;
    }

    // Sessão pareada: qualquer outra queda religa sozinha, sem limite de tentativas
    this.scheduleReconnect(`${name}: ${message}`, {
      code,
      immediate: code === DisconnectReason.restartRequired,
      // outra conexão com a mesma conta derrubou esta: dá um tempo para não ficarem se derrubando
      minDelayMs: code === DisconnectReason.connectionReplaced ? Math.min(this.t.backoffMaxMs, 10 * this.t.backoffBaseMs) : 0,
    });
  }

  /**
   * Socket pronto para enviar. Se a conexão caiu, dispara a religação e espera ela voltar (até timeoutMs)
   * em vez de falhar na hora. Conexão parada há mais tempo que o ping manda um ping antes, para não
   * mandar mensagem por um socket meio-aberto.
   */
  async ready(timeoutMs = 45_000): Promise<WASocket> {
    const deadline = Date.now() + timeoutMs;
    for (let probes = 0; ; probes++) {
      if (this.connected && this.sock) {
        const sock = this.sock;
        if (probes > 0 || Date.now() - this.lastRecvAt < this.t.keepAliveMs * 1.5) return sock;
        if (await this.ping(sock, Math.min(8000, Math.max(1000, deadline - Date.now())))) return sock;
        this.reportBroken(sock, new Error("sem resposta ao ping antes do envio"));
      }
      if (this.stopping) throw new Error("WhatsApp encerrando");
      if (!this.holding) throw new Error("WhatsApp não está conectado: a conexão fica no worker e este processo não está com ela.");
      if (!this.paired) throw new Error("WhatsApp não está conectado. Conecte pelo dashboard (tela WhatsApp).");
      if (!this.sock && !this.reconnectTimer) this.scheduleReconnect("envio pedido com a conexão caída", { immediate: true });
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`WhatsApp reconectando; não consegui enviar em ${Math.round(timeoutMs / 1000)}s. Tente de novo em instantes.`);
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, left);
        this.waiters.add(done);
      });
    }
  }

  private async ping(sock: WASocket, timeoutMs: number) {
    try {
      await sock.query({ tag: "iq", attrs: { id: sock.generateMessageTag(), to: "s.whatsapp.net", type: "get", xmlns: "w:p" }, content: [{ tag: "ping", attrs: {} }] }, timeoutMs);
      if (this.sock === sock) this.lastRecvAt = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  /** Um envio falhou porque o socket morreu por baixo: derruba e religa na hora. */
  reportBroken(sock: WASocket, err: unknown) {
    if (this.sock !== sock || !this.holding) return;
    this.dropSocket();
    this.scheduleReconnect(`envio falhou com a conexão quebrada (${(err as Error)?.message ?? err})`, { immediate: true });
  }

  private wakeWaiters() {
    for (const w of [...this.waiters]) w();
  }

  private queueStatus<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.statusChain.then(fn, fn);
    this.statusChain = p.catch(() => {});
    return p;
  }

  /** Grava o status do painel em ordem. down: "set" marca o início da queda, "clear" zera, "keep" mantém. */
  private setStatus(
    status: Status,
    patch: { qr?: string | null; pairing_code?: string | null; phone?: string | null; name?: string | null; last_error?: string | null } = {},
    down: "set" | "clear" | "keep" = "keep",
  ) {
    return this.queueStatus(() =>
      query(
        `UPDATE wa_sessions SET status = $2, qr = $3, pairing_code = $4,
           phone = COALESCE($5, phone), name = COALESCE($6, name), last_error = $7,
           down_since = CASE WHEN $8 = 'clear' THEN NULL WHEN $8 = 'set' THEN COALESCE(down_since, now()) ELSE down_since END,
           updated_at = now() WHERE id = $1`,
        [SESSION_ID, status, patch.qr ?? null, patch.pairing_code ?? null, patch.phone ?? null, patch.name ?? null, patch.last_error ?? null, down],
      ),
    );
  }

  private async handleIncoming(sock: WASocket, raw: WAMessage) {
    const msg = parseWAMessage(raw, "baileys");
    if (!msg) return;
    void query("UPDATE wa_sessions SET last_message_at = now() WHERE id = $1", [SESSION_ID]).catch(() => {});
    // Baixa a mídia já na chegada (a mídia do WhatsApp expira e o socket só existe aqui)
    if (msg.media && ["audio", "image", "document", "video"].includes(msg.kind)) {
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
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.dropSocket();
    this.wakeWaiters();
    if (this.listenClient) {
      await this.listenClient.query("UNLISTEN wa_command").catch(() => {});
      this.listenClient.release();
      this.listenClient = null;
    }
    await this.statusChain;
    if (this.holding) {
      this.holding = false;
      await query("UPDATE wa_sessions SET holder = NULL, lease_until = NULL WHERE id = $1 AND holder = $2", [SESSION_ID, this.holder]).catch(() => {});
    }
  }
}

export const whatsapp = new WhatsAppSession();

/** Usado pela API: manda um comando para o processo que segura a conexão. */
export async function sendWaCommand(cmd: WaCommand) {
  await query("SELECT pg_notify('wa_command', $1)", [JSON.stringify(cmd)]);
}
