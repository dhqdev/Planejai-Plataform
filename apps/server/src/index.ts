import { buildServer } from "./api/server.js";
import { config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { pool } from "./db/pool.js";
import { stopBoss } from "./queue/boss.js";
import { startWorker } from "./queue/worker.js";
import { whatsapp } from "./whatsapp/session.js";

async function main() {
  const app = await buildServer();
  const log = app.log;

  await migrate((m) => log.info(m));
  if (!config.OPENROUTER_API_KEY) log.warn("OPENROUTER_API_KEY não configurada: o agente não vai responder");
  if (!config.WEBHOOK_SECRET) log.warn("WEBHOOK_SECRET vazio: qualquer um que souber a URL pode enviar mensagens falsas ao webhook");

  if (config.ROLE === "all" || config.ROLE === "worker") {
    await startWorker(log);
    // A conexão do WhatsApp (Baileys) mora no worker, junto de quem envia as respostas
    if (config.WHATSAPP_PROVIDER === "baileys") await whatsapp.start(log);
  }
  if (config.ROLE === "all" || config.ROLE === "api") {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
  }

  const shutdown = async (signal: string) => {
    log.info(`${signal} recebido, encerrando`);
    await whatsapp.stop().catch(() => {});
    await app.close().catch(() => {});
    await stopBoss().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
