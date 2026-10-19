import type { FastifyInstance, FastifyReply } from "fastify";
import type { Account } from "./accounts.js";
import { selfUserId, sharedWithMe } from "./sharing.js";
import { PgListen } from "./whatsapp/rpc.js";

/**
 * Painel em tempo real: as tabelas do painel avisam por pg_notify('pj_live', '<tabela>:<user_id>') (migração 077) e
 * aqui cada aba aberta recebe, por SSE em GET /api/live, só o NOME das tabelas que mudaram e que ela pode ver
 * (super admin: tudo; os outros: a própria pessoa e quem compartilhou tela com ela). A tela recarrega pela rota de
 * sempre, com o escopo de sempre: o aviso nunca leva dado. Sem a conexão (proxy, rede), o painel volta ao polling.
 */
type Client = { reply: FastifyReply; all: boolean; users: Set<string>; pending: Set<string>; timer: NodeJS.Timeout | null };

const clients = new Set<Client>();
// junta avisos seguidos (o time grava várias linhas numa resposta) num envio só por aba
const BATCH_MS = 300;
const PING_MS = 25_000;

const listener = new PgListen("pj_live", (payload) => {
  const at = payload.indexOf(":");
  const table = at < 0 ? payload : payload.slice(0, at);
  const user = at < 0 ? "" : payload.slice(at + 1);
  if (!/^[a-z_]+$/.test(table)) return;
  for (const c of clients) {
    if (!c.all && !(user && c.users.has(user))) continue;
    c.pending.add(table);
    c.timer ??= setTimeout(() => flush(c), BATCH_MS);
  }
});

function flush(c: Client) {
  c.timer = null;
  if (!c.pending.size) return;
  const tables = [...c.pending];
  c.pending.clear();
  write(c, `event: change\ndata: ${JSON.stringify(tables)}\n\n`);
}

function write(c: Client, chunk: string) {
  try {
    c.reply.raw.write(chunk);
  } catch {
    drop(c);
  }
}

function drop(c: Client) {
  if (c.timer) clearTimeout(c.timer);
  clients.delete(c);
}

let ping: NodeJS.Timeout | null = null;
function keepAlive() {
  if (ping) return;
  // comentário SSE a cada 25 s: proxy não derruba a conexão parada e a LISTEN caída se refaz
  ping = setInterval(() => {
    if (!clients.size) {
      clearInterval(ping!);
      ping = null;
      return;
    }
    void listener.ensure().catch(() => {});
    for (const c of clients) write(c, ": ping\n\n");
  }, PING_MS);
  ping.unref();
}

/** Quem esta conta enxerga no painel: null = tudo (super admin). */
async function audience(a: Account): Promise<Set<string> | null> {
  if (a.role === "superadmin") return null;
  const self = await selfUserId(a);
  if (!self) return new Set();
  const shared = await sharedWithMe(self).catch(() => []);
  return new Set([self, ...shared.map((s) => s.id)]);
}

export function liveRoutes(base: FastifyInstance) {
  base.get("/api/live", async (req, reply) => {
    await listener.ensure();
    const users = await audience(req.account);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const c: Client = { reply, all: users === null, users: users ?? new Set(), pending: new Set(), timer: null };
    clients.add(c);
    keepAlive();
    // se a conexão cair, o navegador reconecta em 5 s
    write(c, "retry: 5000\nevent: ready\ndata: {}\n\n");
    req.raw.on("close", () => drop(c));
  });
}

/** Para os testes e o desligamento. */
export async function stopLive() {
  for (const c of clients) {
    drop(c);
    c.reply.raw.end();
  }
  if (ping) clearInterval(ping);
  ping = null;
  await listener.stop();
}
