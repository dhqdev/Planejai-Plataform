import { processConversation, summarizeConversation } from "../agent/orchestrator.js";
import { one } from "../db/pool.js";
import { purgeOld } from "../maintenance.js";
import { dailyImprovement } from "../improve.js";
import { sendInvite } from "../social.js";
import { checkDueWatches } from "../watches.js";
import { config } from "../config.js";
import { afterFire } from "../reminders.js";
import { QUEUES, getBoss } from "./boss.js";

export async function startWorker(log: { info: (...a: any[]) => void; error: (...a: any[]) => void }, concurrency = 4) {
  const boss = await getBoss();

  // Cada registro de work() é um consumidor independente: N conversas em paralelo.
  for (let i = 0; i < concurrency; i++) {
    await boss.work<{ conversationId: string }>(QUEUES.process, { batchSize: 1, pollingIntervalSeconds: 1 }, async ([job]) => {
      if (!job) return;
      const r = await processConversation(job.data.conversationId, { trigger: "message" });
      log.info({ conversationId: job.data.conversationId, executionId: r.executionId, bubbles: r.bubbles.length }, "conversa processada");
      await boss.send(QUEUES.summarize, { conversationId: job.data.conversationId }, { singletonKey: job.data.conversationId, startAfter: 30 });
    });
  }

  await boss.work<{ reminderId: string }>(QUEUES.reminder, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    const reminder = await one("SELECT * FROM reminders WHERE id = $1", [job.data.reminderId]);
    if (!reminder || reminder.status !== "scheduled") return;
    let ok = false;
    try {
      await processConversation(reminder.conversation_id, {
        trigger: "reminder",
        event:
          `Lembrete agendado disparou agora. O que lembrar: ${reminder.intent}` +
          (reminder.cron ? ` (lembrete recorrente: ${reminder.cron})` : "") +
          ". Escreva a mensagem para a pessoa.",
      });
      ok = true;
    } finally {
      await afterFire(reminder.id, ok);
    }
  });

  await boss.work<{ conversationId: string }>(QUEUES.summarize, { batchSize: 1, pollingIntervalSeconds: 10 }, async ([job]) => {
    if (job) await summarizeConversation(job.data.conversationId);
  });

  await boss.work(QUEUES.purge, { batchSize: 1, pollingIntervalSeconds: 30 }, async () => {
    await purgeOld(log);
  });
  // de hora em hora: resume e apaga mensagens com mais de 24h, logs e gravações antigas
  await boss.schedule(QUEUES.purge, "17 * * * *");

  // convites saem pelo worker (é ele que segura a conexão do WhatsApp)
  await boss.work<{ inviteId: string }>(QUEUES.invite, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (job) await sendInvite(job.data.inviteId);
  });

  // acompanhamentos (preço, novidades): checagem sem IA a cada 15 min, só os vencidos
  await boss.work(QUEUES.watch, { batchSize: 1, pollingIntervalSeconds: 30 }, async () => {
    await checkDueWatches(log);
  });
  await boss.schedule(QUEUES.watch, "*/15 * * * *");

  // melhoria diária dos agentes de cada cliente, às 19h
  await boss.work(QUEUES.improve, { batchSize: 1, pollingIntervalSeconds: 60 }, async () => {
    await dailyImprovement(log);
  });
  await boss.schedule(QUEUES.improve, "0 19 * * *", undefined, { tz: config.DEFAULT_TIMEZONE });

  log.info("worker iniciado (filas: processamento, lembretes, resumos)");
}
