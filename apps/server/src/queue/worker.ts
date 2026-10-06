import { processConversation, summarizeConversation } from "../agent/orchestrator.js";
import { one } from "../db/pool.js";
import { purgeOld } from "../maintenance.js";
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

  log.info("worker iniciado (filas: processamento, lembretes, resumos)");
}
