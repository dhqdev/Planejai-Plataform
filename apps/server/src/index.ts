import { buildServer } from "./api/server.js";
import { config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { pool } from "./db/pool.js";
import { startAliveBeat } from "./alive.js";
import { reencryptStale } from "./integrations/registry.js";
import { startProcessBeat } from "./resources.js";
import { stopBoss } from "./queue/boss.js";
import { startWorker } from "./queue/worker.js";
import { runsApi, runsChannel, runsConversations } from "./roles.js";
import { stopRpcClient } from "./whatsapp/rpc.js";
import { whatsapp } from "./whatsapp/session.js";

async function main() {
  const app = await buildServer();
  const log = app.log;

  await waitForDatabase(log);
  await migrate((m) => log.info(m));
  await reencryptStale((m) => log.warn(m));
  if (!config.SESSION_SECRET || !config.ENCRYPTION_KEY) log.warn("SESSION_SECRET/ENCRYPTION_KEY vazios: usando o APP_SECRET legado para tudo. Defina os dois na stack.");
  if (!config.INTERNAL_API_KEY) log.warn("INTERNAL_API_KEY vazia: a API interna (n8n) fica desligada");
  if (!config.OPENROUTER_API_KEY) log.warn("OPENROUTER_API_KEY não configurada: o agente não vai responder");
  if (config.WHATSAPP_PROVIDER === "evolution" && !config.WEBHOOK_SECRET) log.warn("WEBHOOK_SECRET vazio: o webhook da Evolution vai recusar tudo até você configurar");
  if (config.WHATSAPP_PROVIDER === "cloud" && !config.WHATSAPP_CLOUD_APP_SECRET) log.warn("WHATSAPP_CLOUD_APP_SECRET vazio: o webhook da Meta vai recusar tudo até você configurar");

  // foto de memória e CPU deste processo para a tela Servidor (API e worker)
  startProcessBeat();
  // papéis em roles.ts: worker/all = channel + conversations; channel = 1 réplica; conversations = N réplicas
  if (runsChannel() || runsConversations()) {
    await startWorker(log, config.WORKER_CONCURRENCY);
    startAliveBeat();
    // A conexão do WhatsApp (Baileys) mora no processo do canal; as réplicas de conversa enviam por ele (whatsapp/rpc.ts)
    if (runsChannel() && config.WHATSAPP_PROVIDER === "baileys") await whatsapp.start(log);
  }
  if (runsApi()) {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
  }

  const shutdown = async (signal: string) => {
    log.info(`${signal} recebido, encerrando`);
    await whatsapp.stop().catch(() => {});
    await stopRpcClient().catch(() => {});
    await app.close().catch(() => {});
    await stopBoss().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

/**
 * No Swarm o app e o worker podem subir antes do Postgres aceitar conexões (atualização da stack,
 * reinício do servidor). Espera o banco em vez de sair com erro e marcar a atualização como falha.
 */
async function waitForDatabase(log: { warn: (msg: string) => void }) {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      if (attempt >= 45) throw err;
      log.warn(`banco ainda não respondeu (${(err as Error).message}); tentando de novo em 2s`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
