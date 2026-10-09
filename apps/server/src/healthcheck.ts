/**
 * Healthcheck do container (Dockerfile HEALTHCHECK): `node apps/server/dist/healthcheck.js`.
 * - api/all: o /health responde (banco no ar).
 * - worker/all/channel/conversations: o processo está vivo (arquivo de batida renovado a cada 15s).
 * - worker/all/channel, com Baileys: a conexão do WhatsApp que ESTE container segura não está travada (aluguel renovado e sem ficar "conectando" para sempre).
 *   A sessão religa sozinha com espera de até 60s entre tentativas (whatsapp/session.ts); se mesmo assim ficar
 *   caída por mais de 10 min (~10 tentativas), um processo novo (DNS, sockets e memória limpos) é a próxima aposta.
 *   Com interval=30s e retries=3 do HEALTHCHECK, o Swarm reinicia ~11-12 min depois da queda.
 * Saída 1 = doente: o Swarm reinicia o container.
 */
import { statSync } from "node:fs";
import { hostname } from "node:os";
import pg from "pg";
import { config } from "./config.js";
import { ALIVE_FILE } from "./alive.js";
import { runsApi, runsChannel } from "./roles.js";

async function check(): Promise<string | null> {
  if (runsApi()) {
    const res = await fetch(`http://127.0.0.1:${config.PORT}/health`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
    if (!res?.ok) return "api sem resposta em /health";
  }
  if (config.ROLE === "api") return null;

  let age = Infinity;
  try {
    age = Date.now() - statSync(ALIVE_FILE).mtimeMs;
  } catch {
    /* sem arquivo ainda */
  }
  // sem arquivo = ainda subindo (o start-period do HEALTHCHECK cobre); arquivo velho = processo travado
  if (age !== Infinity && age > 90_000) return `worker parado há ${Math.round(age / 1000)}s`;

  // conversations não segura o WhatsApp: basta estar vivo
  if (!runsChannel() || config.WHATSAPP_PROVIDER !== "baileys") return null;
  const client = new pg.Client({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    const { rows } = await client.query(
      `SELECT holder, status, now() - heartbeat_at > interval '90 seconds' AS stale_beat,
              status IN ('connecting', 'reconnecting') AND now() - updated_at > interval '5 minutes' AS stuck,
              status = 'reconnecting' AND now() - down_since > interval '10 minutes' AS down_too_long
         FROM wa_sessions WHERE id = 'default'`,
    );
    const s = rows[0];
    if (!s || !String(s.holder ?? "").startsWith(`${hostname()}:`)) return null; // outro container segura (ou ninguém ainda)
    if (s.stale_beat) return "conexão do WhatsApp sem batida há mais de 90s";
    if (s.stuck) return "WhatsApp preso em 'conectando' há mais de 5 min";
    if (s.down_too_long) return "WhatsApp caído há mais de 10 min sem conseguir reconectar";
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

check().then(
  (problem) => {
    if (problem) {
      console.error(`doente: ${problem}`);
      process.exit(1);
    }
    process.exit(0);
  },
  (err) => {
    console.error(`doente: ${(err as Error).message}`);
    process.exit(1);
  },
);
