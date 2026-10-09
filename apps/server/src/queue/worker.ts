import { emitEvent } from "../events.js";
import { type OutboundJob, runOutboundJob } from "../api/routes/internal.js";
import { startTelegramPolling } from "../telegram.js";
import { processConversation, summarizeConversation } from "../agent/orchestrator.js";
import { one } from "../db/pool.js";
import { purgeOld } from "../maintenance.js";
import { snapshotStorage } from "../resources.js";
import { dailyImprovement } from "../improve.js";
import { sendInvite } from "../social.js";
import { checkDueWatches } from "../watches.js";
import { billingReminders } from "../billing.js";
import { remindBills } from "../bills.js";
import { config } from "../config.js";
import { afterFire } from "../reminders.js";
import { runsChannel, runsConversations } from "../roles.js";
import { QUEUES, getBoss } from "./boss.js";

type WorkerLog = { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };

/**
 * Registra os consumidores das filas conforme o papel (roles.ts): ROLE=worker/all fazem as duas partes.
 * Os jobs agendados (boss.schedule) ficam só na parte do canal: 1 réplica, um dono só para o cron.
 */
export async function startWorker(log: WorkerLog, concurrency = 4, parts = { channel: runsChannel(), conversations: runsConversations() }) {
  if (parts.conversations) await startConversations(log, concurrency);
  if (parts.channel) await startChannelJobs(log);
  log.info(`worker iniciado (${[parts.channel && "canal", parts.conversations && "conversas"].filter(Boolean).join(" + ")})`);
}

/** Conversas, lembretes, recados e resumos: escala em N réplicas (ROLE=conversations). */
async function startConversations(log: WorkerLog, concurrency: number) {
  const boss = await getBoss();

  // Cada registro de work() é um consumidor independente: N conversas em paralelo.
  for (let i = 0; i < concurrency; i++) {
    await boss.work<{ conversationId: string }>(QUEUES.process, { batchSize: 1, pollingIntervalSeconds: 1, includeMetadata: true }, async ([job]) => {
      if (!job) return;
      // ainda há nova tentativa na fila: erro passageiro (OpenRouter fora, rede) não perde as mensagens
      const retryable = job.retryCount < job.retryLimit;
      const r = await processConversation(job.data.conversationId, { trigger: "message", retryable, wait: false });
      if (r.busy) {
        // a rodada anterior desta conversa ainda está trabalhando: volta para a fila em vez de ocupar esta vaga esperando.
        // Com a policy "short" fica no máximo um job aguardando por conversa, e ele pega todas as mensagens pendentes.
        await boss.send(QUEUES.process, { conversationId: job.data.conversationId }, { singletonKey: job.data.conversationId, startAfter: 5, retryLimit: 1, retryDelay: 15, priority: 10, expireInSeconds: job.expireInSeconds ?? 600 });
        return;
      }
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
        plainText: `Lembrete: ${reminder.intent}`,
      });
      ok = true;
      void emitEvent("reminder.fired", { user_id: reminder.user_id, reminder_id: reminder.id, intent: reminder.intent });
    } finally {
      await afterFire(reminder.id, ok);
    }
  });

  // recados: o estabelecimento respondeu, o agente de recados decide o próximo passo
  await boss.work<{ errandId: string }>(QUEUES.errand, { batchSize: 1, pollingIntervalSeconds: 3 }, async ([job]) => {
    if (!job) return;
    const { runErrandTurn } = await import("../agent/errand-agent.js");
    const r = await runErrandTurn(job.data.errandId);
    log.info({ errandId: job.data.errandId, outcome: r?.kind ?? "aguardando" }, "recado");
  });

  await boss.work<{ conversationId: string }>(QUEUES.summarize, { batchSize: 1, pollingIntervalSeconds: 10 }, async ([job]) => {
    if (job) await summarizeConversation(job.data.conversationId);
  });
}

/** Envios, convites, Telegram por polling e todos os jobs agendados: 1 réplica (ROLE=channel). */
async function startChannelJobs(log: WorkerLog) {
  const boss = await getBoss();

  await boss.work(QUEUES.purge, { batchSize: 1, pollingIntervalSeconds: 30 }, async () => {
    await purgeOld(log);
    await snapshotStorage().catch((err) => log.error({ err }, "falha na foto diária de armazenamento"));
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

  // contas fixas e mensalidade: lembretes do dia, às 9h (sem IA)
  await boss.work(QUEUES.financeDaily, { batchSize: 1, pollingIntervalSeconds: 60 }, async () => {
    await remindBills(log).catch((err) => log.error({ err }, "lembretes de contas falharam"));
    await billingReminders(log).catch((err) => log.error({ err }, "lembretes de assinatura falharam"));
  });
  await boss.schedule(QUEUES.financeDaily, "0 9 * * *", undefined, { tz: config.DEFAULT_TIMEZONE });

  // mensagens pedidas pelo n8n / automações (API interna)
  await boss.work<OutboundJob>(QUEUES.outbound, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (job) await runOutboundJob(job.data);
  });

  // envios pedidos pelas réplicas de conversa (ROLE=conversations) a quem segura o WhatsApp
  if (config.WHATSAPP_PROVIDER === "baileys") {
    const { startChannelRpc } = await import("../whatsapp/rpc-server.js");
    await startChannelRpc(log);
  }

  // Telegram sem webhook (sem https público): só um processo pode buscar as mensagens
  startTelegramPolling(log);
}
