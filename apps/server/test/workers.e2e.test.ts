import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * ROLE=channel + ROLE=conversations: um processo filho de conversas (só filas de conversa, sem WhatsApp)
 * processa a mensagem e a resposta sai pelo socket (falso) do processo de canal, que é este aqui.
 */
class FakeSock {
  ev = new EventEmitter();
  ws = Object.assign(new EventEmitter(), { isOpen: true });
  sent: { jid: string; content: any }[] = [];
  presence: string[] = [];
  read = 0;
  private traffic: NodeJS.Timeout;
  constructor(public authState: { creds: any }) {
    this.traffic = setInterval(() => this.ws.emit("message", Buffer.from("x")), 50);
    this.traffic.unref();
  }
  get user() {
    return this.authState.creds.me;
  }
  generateMessageTag() {
    return "tag";
  }
  async query() {
    return {};
  }
  async end() {
    clearInterval(this.traffic);
    this.ws.isOpen = false;
  }
  async sendMessage(jid: string, content: any) {
    this.sent.push({ jid, content });
    return { key: { id: `wa${this.sent.length}` } };
  }
  async sendPresenceUpdate(kind: string) {
    this.presence.push(kind);
  }
  async readMessages() {
    this.read++;
  }
}

async function until(fn: () => boolean | Promise<boolean>, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`condição não aconteceu em ${ms}ms: ${fn.toString()}`);
}

const completion = (content: string) => ({
  model: "fake/model",
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.000001 },
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("channel + conversations em processos separados", () => {
  let db: typeof import("../src/db/pool.js");
  let session: import("../src/whatsapp/session.js").WhatsAppSession;
  let rpc: { stop: () => Promise<void> };
  let child: ChildProcess | undefined;
  let server: http.Server;
  let sock: FakeSock | undefined;
  const childErr: string[] = [];
  const quiet = { info: () => {}, warn: () => {}, error: () => {} };

  beforeAll(async () => {
    server = http
      .createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(completion("Oi! Resposta do time 👋")));
        });
      })
      .listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA IF EXISTS pgboss CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});

    // processo de canal (este): sessão pareada com socket falso + consumidor da fila whatsapp.send
    const mod = await import("../src/whatsapp/session.js");
    const auth = await import("../src/whatsapp/auth-state.js");
    const a = await auth.usePgAuthState(mod.SESSION_ID);
    a.state.creds.me = { id: "5511999990000:3@s.whatsapp.net", name: "Assistente" };
    a.state.creds.account = { details: Buffer.from([1]), accountSignatureKey: Buffer.from([2]), accountSignature: Buffer.from([3]), deviceSignature: Buffer.from([4]) } as any;
    await a.saveCreds();
    session = new mod.WhatsAppSession({
      holder: "canal:1:abc",
      fetchVersion: async () => undefined,
      makeSocket: (cfg) => {
        sock = new FakeSock(cfg.auth as any);
        const s = sock;
        setTimeout(() => s.ev.emit("connection.update", { connection: "open" }), 10);
        return s as any;
      },
    });
    await session.start(quiet);
    await until(() => session.connected, 5000);
    const { BaileysChannel } = await import("../src/channels/baileys.js");
    rpc = await (await import("../src/whatsapp/rpc-server.js")).startChannelRpc(quiet, { channel: new BaileysChannel(session, false) });

    // processo de conversas (filho): ROLE=conversations, sem WhatsApp próprio
    child = spawn(process.execPath, ["--import", "tsx", "test/fixtures/conversations-proc.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      // só o filho chama a IA: OpenRouter falso numa porta livre (outras suítes usam a 4599)
      env: { ...process.env, ROLE: "conversations", OPENROUTER_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let ready = false;
    child.stdout!.on("data", (d) => (ready ||= String(d).includes("pronto")));
    child.stderr!.on("data", (d) => childErr.push(String(d)));
    await until(() => ready || child!.exitCode !== null, 30_000);
    expect(child.exitCode, childErr.join("")).toBeNull();
  }, 60_000);

  afterAll(async () => {
    child?.kill("SIGKILL");
    server?.close();
    await rpc?.stop();
    await session?.stop();
    const { stopRpcClient } = await import("../src/whatsapp/rpc.js");
    await stopRpcClient();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  it("a resposta processada no conversations sai pelo WhatsApp do channel, com o id da mensagem", async () => {
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    const user = await upsertUser("5519900000077", "Ana");
    await db.query("UPDATE users SET status = 'active' WHERE id = $1", [user.id]);
    const jid = "5519900000077@s.whatsapp.net";
    const conv = await upsertConversation(user.id, "baileys", jid);
    await db.query("INSERT INTO messages (conversation_id, role, content, external_id) VALUES ($1, 'user', 'oi, tudo certo?', 'in-77')", [conv.id]);

    const { QUEUES, getBoss } = await import("../src/queue/boss.js");
    await (await getBoss()).send(QUEUES.process, { conversationId: conv.id });

    await until(() => Boolean(sock?.sent.some((s) => s.content.text === "Oi! Resposta do time 👋")), 40_000);
    expect(sock!.sent.find((s) => s.content.text)!.jid).toBe(jid);
    // o id devolvido pelo socket do channel volta ao conversations (fica no passo da execução)
    const id = `wa${sock!.sent.findIndex((s) => s.content.text === "Oi! Resposta do time 👋") + 1}`;
    await until(async () => Boolean(await db.one("SELECT 1 FROM execution_steps WHERE name = 'enviar_texto' AND output->>'id' = $1", [id])), 10_000);
    // "digitando" e lido também passam pelo channel
    expect(sock!.presence).toContain("composing");
    expect(sock!.read).toBeGreaterThan(0);
    const jobs = await db.many("SELECT state FROM pgboss.job WHERE name = $1", [QUEUES.waRpc]);
    expect(jobs.length).toBeGreaterThan(0);
  }, 60_000);
});
