import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Erro no formato Boom do Baileys (lastDisconnect.error.output.statusCode). */
const boom = (message: string, statusCode?: number) => Object.assign(new Error(message), statusCode ? { output: { statusCode } } : {});

/**
 * Socket falso do Baileys: mesmo contrato que a sessão usa (ev, ws, user, end, logout, query, sendMessage).
 * Enquanto não estiver "mudo", recebe tráfego do servidor a cada 50ms (como a resposta do ping).
 */
class FakeSock {
  ev = new EventEmitter();
  ws = Object.assign(new EventEmitter(), { isOpen: true });
  ended = false;
  silent = false;
  pingOk = true;
  failNextSend: Error | null = null;
  sent: { jid: string; content: any }[] = [];
  private traffic: NodeJS.Timeout;

  constructor(public authState: { creds: any }) {
    this.traffic = setInterval(() => {
      if (!this.ended && !this.silent && this.ws.isOpen) this.ws.emit("message", Buffer.from("x"));
    }, 50);
    this.traffic.unref();
  }
  get user() {
    return this.authState.creds.me;
  }
  generateMessageTag() {
    return "tag";
  }
  async query() {
    if (!this.pingOk) throw boom("Timed Out", 408);
    return {};
  }
  async end(err?: Error) {
    if (this.ended) return;
    this.ended = true;
    this.ws.isOpen = false;
    clearInterval(this.traffic);
    this.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: err, date: new Date() } });
  }
  async logout() {
    await this.end(boom("Intentional Logout", 401));
  }
  async sendMessage(jid: string, content: any) {
    if (this.failNextSend) {
      const e = this.failNextSend;
      this.failNextSend = null;
      throw e;
    }
    this.sent.push({ jid, content });
    return { key: { id: `m${this.sent.length}` } };
  }
  async sendPresenceUpdate() {}
  async readMessages() {}
  openUp() {
    this.ev.emit("connection.update", { connection: "open" });
  }
  /** queda vinda do servidor/rede, como o Baileys emite */
  drop(code: number | undefined, message = "caiu") {
    void this.end(boom(message, code));
  }
}

async function until(fn: () => boolean | Promise<boolean>, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`condição não aconteceu em ${ms}ms: ${fn.toString()}`);
}

/** Religação do WhatsApp (Baileys) com socket falso: quedas, socket meio-aberto, aluguel e envio com a conexão caída. */
describe.skipIf(!process.env.TEST_DATABASE_URL)("reconexão do WhatsApp", () => {
  let db: typeof import("../src/db/pool.js");
  let mod: typeof import("../src/whatsapp/session.js");
  let session: import("../src/whatsapp/session.js").WhatsAppSession;
  let channel: import("../src/channels/baileys.js").BaileysChannel;
  const sockets: FakeSock[] = [];
  let autoOpen = true;
  const last = () => sockets[sockets.length - 1]!;
  const row = () => db.one<any>("SELECT status, last_error, down_since, holder FROM wa_sessions WHERE id = 'default'");
  const quiet = { info: () => {}, warn: () => {}, error: () => {} };
  const logs: string[] = [];
  const log = { ...quiet, warn: (...a: any[]) => logs.push(String(a[a.length - 1])) };

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    mod = await import("../src/whatsapp/session.js");
    const auth = await import("../src/whatsapp/auth-state.js");

    // Sessão pareada pelo QR: o Baileys deixa registered=false; o que existe é account + me
    const a = await auth.usePgAuthState(mod.SESSION_ID);
    a.state.creds.me = { id: "5511999990000:3@s.whatsapp.net", name: "Assistente" };
    a.state.creds.account = { details: Buffer.from([1]), accountSignatureKey: Buffer.from([2]), accountSignature: Buffer.from([3]), deviceSignature: Buffer.from([4]) } as any;
    await a.saveCreds();
    expect(a.state.creds.registered).toBe(false);
    expect(mod.isPaired(a.state.creds)).toBe(true);

    session = new mod.WhatsAppSession({
      holder: "teste:1:abc",
      timings: { heartbeatMs: 80, leaseSeconds: 1, keepAliveMs: 200, staleMs: 500, openTimeoutMs: 1500, backoffBaseMs: 20, backoffMaxMs: 150 },
      makeSocket: (cfg) => {
        const s = new FakeSock(cfg.auth as any);
        sockets.push(s);
        if (autoOpen) setTimeout(() => s.openUp(), 10);
        return s as any;
      },
      fetchVersion: async () => undefined,
    });
    channel = new (await import("../src/channels/baileys.js")).BaileysChannel(session);
  });
  afterAll(async () => {
    await session?.stop();
    await db?.pool.end();
  });

  it("sessão pareada pelo QR (registered=false) conecta sozinha ao subir", async () => {
    await session.start(log);
    await until(() => session.connected);
    expect(sockets).toHaveLength(1);
    await until(async () => (await row()).status === "connected");
    expect((await row()).holder).toBe("teste:1:abc");
  });

  it("connectionLost depois de ociosa vira 'reconectando' (não 'desconectado') e volta sozinha", async () => {
    autoOpen = false;
    sockets[0]!.drop(408, "Connection was lost");
    await until(() => sockets.length === 2);
    const r = await row();
    expect(r.status).toBe("reconnecting");
    expect(r.down_since).not.toBeNull();
    expect(r.last_error).toContain("connectionLost");
    expect(logs.some((l) => l.includes("connectionLost"))).toBe(true);

    last().openUp();
    await until(async () => (await row()).status === "connected");
    expect((await row()).down_since).toBeNull();
    autoOpen = true;
  });

  it("religa em todo DisconnectReason que não é logout, sem deixar socket antigo vivo", async () => {
    for (const code of [428, 408, 440, 500, 503, 411, 515, undefined]) {
      const n = sockets.length;
      last().drop(code, `queda ${code}`);
      await until(() => sockets.length > n && session.connected);
      expect(sockets.filter((s) => !s.ended)).toHaveLength(1);
    }
    expect((await row()).status).toBe("connected");
  });

  it("socket meio-aberto (sem close e sem tráfego) é derrubado pelo vigia e religado", async () => {
    let n = sockets.length;
    const mute = last();
    mute.silent = true;
    await until(() => sockets.length > n && session.connected);
    expect(mute.ended).toBe(true);

    // websocket fechou sem o Baileys emitir 'close'
    n = sockets.length;
    const closed = last();
    closed.ws.isOpen = false;
    await until(() => sockets.length > n && session.connected);
    expect(closed.ended).toBe(true);
    expect(logs.some((l) => l.includes("meio-aberto"))).toBe(true);
  });

  it("envio com a conexão caída espera religar em vez de falhar", async () => {
    autoOpen = false;
    const n = sockets.length;
    last().drop(428, "Connection Terminated");
    await until(() => sockets.length > n);
    const sending = channel.sendText("5511988887777@s.whatsapp.net", "oi");
    await new Promise((r) => setTimeout(r, 100));
    last().openUp();
    expect((await sending).id).toBeTruthy();
    expect(last().sent.map((m) => m.content.text)).toEqual(["oi"]);
    autoOpen = true;
  });

  it("socket que morre no meio do envio: derruba, religa e reenvia", async () => {
    await until(() => session.connected);
    const n = sockets.length;
    const broken = last();
    broken.failNextSend = boom("Connection Closed", 428);
    await channel.sendText("5511988887777@s.whatsapp.net", "de novo");
    expect(sockets.length).toBeGreaterThan(n);
    expect(broken.sent.map((m) => m.content.text)).not.toContain("de novo");
    expect(last().sent.map((m) => m.content.text)).toEqual(["de novo"]);
  });

  it("sem tráfego há um tempo, pinga antes de enviar e religa se o ping falhar", async () => {
    await until(() => session.connected);
    const n = sockets.length;
    const stale = last();
    stale.silent = true;
    stale.pingOk = false;
    await new Promise((r) => setTimeout(r, 330)); // > 1,5 x keepAlive, < staleMs
    await channel.sendText("5511988887777@s.whatsapp.net", "ping antes");
    expect(sockets.length).toBeGreaterThan(n);
    expect(stale.sent.map((m) => m.content.text)).not.toContain("ping antes");
    expect(last().sent.map((m) => m.content.text)).toEqual(["ping antes"]);
  });

  it("perde o aluguel para outro processo e reassume quando ele vence", async () => {
    await until(() => session.connected);
    const held = last();
    await db.query("UPDATE wa_sessions SET holder = 'outro:2:def', lease_until = now() + interval '1 hour' WHERE id = 'default'");
    await until(() => held.ended && !session.holdsLease);
    expect(session.connected).toBe(false);

    const n = sockets.length;
    await db.query("UPDATE wa_sessions SET lease_until = now() - interval '1 second' WHERE id = 'default'");
    await until(() => sockets.length > n && session.connected);
    expect((await row()).holder).toBe("teste:1:abc");
    await until(async () => (await row()).status === "connected");
  });

  it("loggedOut pelo celular limpa a sessão, pede QR e não fica religando", async () => {
    await until(() => session.connected);
    last().drop(401, "Connection Failure");
    await until(async () => (await row()).status === "disconnected");
    expect((await row()).last_error).toContain("Sessão encerrada no celular");
    expect(await db.one("SELECT COUNT(*)::int AS n FROM wa_auth WHERE session = 'default'")).toEqual({ n: 0 });
    const n = sockets.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(sockets.length).toBe(n);
    await expect(channel.sendText("5511988887777@s.whatsapp.net", "oi")).rejects.toThrow(/Conecte pelo dashboard/);
  });

  it("QR que expira (timedOut sem pareamento) mostra 'desconectado' com o motivo", async () => {
    autoOpen = false;
    await session.handleCommand({ action: "connect" });
    const qrSock = last();
    qrSock.ev.emit("connection.update", { qr: "2@abc,def,ghi" });
    await until(async () => (await row()).status === "qr");
    qrSock.drop(408, "QR refs attempts ended");
    await until(async () => (await row()).status === "disconnected");
    expect((await row()).last_error).toContain("QR code expirou");
  });
});
