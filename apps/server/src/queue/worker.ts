import { emitEvent } from "../events.js";
import { type OutboundJob, runOutboundJob } from "../api/routes/internal.js";
import { startTelegramPolling } from "../telegram.js";
import { processConversation, summarizeConversation } from "../agent/orchestrator.js";
import { one } from "../db/pool.js";
import { purgeOld, summarizeDay } from "../maintenance.js";
import { unpinExpired } from "../agent/pins.js";
import { snapshotStorage } from "../resources.js";
import { dailyImprovement, MEETING_HOUR } from "../improve.js";
import { sendInvite } from "../social.js";
import { checkDueWatches } from "../watches.js";
import { billingReminders } from "../billing.js";
import { remindBills } from "../bills.js";
import { config } from "../config.js";
import { afterFire } from "../reminders.js";
import { startAlarmWorker } from "../alarms.js";
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
      // compromisso de um agendamento pelo link público: aviso pronto, sem IA
      const { ownerReminderText } = await import("../booking.js");
      const fixed = await ownerReminderText(reminder.id);
      if (fixed) {
        const { notifyUser } = await import("../social.js");
        await notifyUser(reminder.user_id, fixed);
        ok = true;
        return;
      }
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

  // alarme: notificação no celular e WhatsApp, sem IA
  await startAlarmWorker(boss);

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
    await unpinExpired(log).catch((err) => log.error({ err }, "falha ao desafixar mensagens antigas"));
    await snapshotStorage().catch((err) => log.error({ err }, "falha na foto diária de armazenamento"));
  });
  // de hora em hora: resume e apaga mensagens com mais de 24h, logs e gravações antigas
  await boss.schedule(QUEUES.purge, "17 * * * *");
  // rede social: o perfil oficial e os posts de partida aparecem logo depois do deploy, sem esperar a hora cheia
  void import("../feed-oficial.js").then((m) => m.syncOfficialFeed()).catch((err) => log.error({ err }, "falha ao postar no perfil oficial da rede"));

  // convites saem pelo worker (é ele que segura a conexão do WhatsApp)
  await boss.work<{ inviteId: string }>(QUEUES.invite, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (job) await sendInvite(job.data.inviteId);
  });

  // acompanhamentos (preço, novidades): checagem sem IA a cada 15 min, só os vencidos
  await boss.work(QUEUES.watch, { batchSize: 1, pollingIntervalSeconds: 30 }, async () => {
    await checkDueWatches(log);
  });
  await boss.schedule(QUEUES.watch, "*/15 * * * *");

  // o checkout pelo navegador saiu (Compras virou busca de preço): tira o agendamento antigo do banco
  await boss.unschedule("purchases.check").catch(() => {});

  // melhoria diária dos agentes de cada cliente, às 19h
  await boss.work(QUEUES.improve, { batchSize: 1, pollingIntervalSeconds: 60 }, async () => {
    // primeiro o resumo do dia de cada conversa (um por dia, não de hora em hora); a reunião já lê o resumo novo
    await summarizeDay(log).catch((err) => log.error({ err }, "resumo do dia falhou"));
    await dailyImprovement(log);
  });
  await boss.schedule(QUEUES.improve, `0 ${MEETING_HOUR} * * *`, undefined, { tz: config.DEFAULT_TIMEZONE });

  // contas fixas, faturas de cartão e mensalidade: lembretes do dia, às 9h (sem IA)
  await boss.work(QUEUES.financeDaily, { batchSize: 1, pollingIntervalSeconds: 60 }, async () => {
    await remindBills(log).catch((err) => log.error({ err }, "lembretes de contas falharam"));
    const { remindCards } = await import("../cards.js");
    await remindCards(log).catch((err) => log.error({ err }, "lembretes de fatura falharam"));
    await billingReminders(log).catch((err) => log.error({ err }, "lembretes de assinatura falharam"));
    const { sendScheduledReports } = await import("../finance-report.js");
    await sendScheduledReports(log).catch((err) => log.error({ err }, "relatórios financeiros falharam"));
  });
  await boss.schedule(QUEUES.financeDaily, "0 9 * * *", undefined, { tz: config.DEFAULT_TIMEZONE });

  // resumo do gasto de IA do dia que acabou, no WhatsApp do dono, logo depois da meia-noite (sem IA)
  await boss.work(QUEUES.usageReport, { batchSize: 1, pollingIntervalSeconds: 60 }, async () => {
    const { sendDailyUsageReport } = await import("../usage-report.js");
    await sendDailyUsageReport(log).catch((err) => log.error({ err }, "resumo diário de gasto falhou"));
  });
  await boss.schedule(QUEUES.usageReport, "2 0 * * *", undefined, { tz: config.DEFAULT_TIMEZONE });

  // backup do banco no bucket (Backblaze), às 3h30: dump + ficha + conferência dos arquivos (backup.ts)
  await boss.work(QUEUES.backup, { batchSize: 1, pollingIntervalSeconds: 60 }, async () => {
    const { storageEnabled } = await import("../storage.js");
    if (!storageEnabled()) return;
    const { runBackup } = await import("../backup.js");
    await runBackup("agenda", { log: (m) => log.info(m) }).catch((err) => log.error({ err }, "backup no bucket falhou"));
  });
  await boss.schedule(QUEUES.backup, "30 3 * * *", undefined, { tz: config.DEFAULT_TIMEZONE });

  // blog público: de hora em hora confere posts de partida, ilustrações que faltam e o post da semana (dia e hora no painel)
  await boss.work<import("../blog.js").BlogJob>(QUEUES.blog, { batchSize: 1, pollingIntervalSeconds: 10 }, async ([job]) => {
    const { runBlogJob } = await import("../blog.js");
    await runBlogJob(log, job?.data ?? {});
  });
  await boss.schedule(QUEUES.blog, "41 * * * *", { action: "tick" });

  // status do WhatsApp: de hora em hora vê se é dia de postar (desligado até o dono ligar no painel)
  await boss.work(QUEUES.waStatus, { batchSize: 1, pollingIntervalSeconds: 30 }, async () => {
    const { runStatusTick } = await import("../wa-status.js");
    await runStatusTick(log);
  });
  await boss.schedule(QUEUES.waStatus, "23 * * * *");

  // dicas dos primeiros dias e da semana depois do uso livre (sem IA): de hora em hora vê quem está na hora e manda com minuto sorteado
  await boss.work<{ userId?: string; step?: import("../trial-tips.js").TipStep; week?: number; tick?: boolean }>(QUEUES.trialTips, { batchSize: 1, pollingIntervalSeconds: 15 }, async ([job]) => {
    const tips = await import("../trial-tips.js");
    const week = await import("../week-tips.js");
    if (job?.data?.userId && job.data.step) await tips.sendTrialTip(job.data.userId, job.data.step);
    else if (job?.data?.userId && job.data.week) await week.sendWeekTip(job.data.userId, job.data.week);
    else {
      await tips.scheduleTrialTips(log).catch((err) => log.error({ err }, "dicas dos primeiros dias falharam"));
      await week.scheduleWeekTips(log).catch((err) => log.error({ err }, "dicas da semana depois do teste falharam"));
    }
  });
  await boss.schedule(QUEUES.trialTips, "3 * * * *", { tick: true });

  // secretária de reuniões: cada trecho do Meet vira texto e, no fim, a ata em PDF
  await boss.work<import("../meet.js").MeetJob>(QUEUES.meet, { batchSize: 1, pollingIntervalSeconds: 3 }, async ([job]) => {
    const { runMeetJob } = await import("../meet.js");
    if (job) await runMeetJob(job.data, log);
  });

  // Uber (beta): só aqui (parte do canal, 1 réplica), então UBER_CONCURRENCY é o teto de Chromes da Uber no sistema todo
  for (let i = 0; i < config.UBER_CONCURRENCY; i++) {
    await boss.work<import("../uber.js").UberJob>(QUEUES.uber, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
      const { runUberJob } = await import("../uber.js");
      if (job) await runUberJob(job.data, log);
    });
  }

  // mensagens pedidas pelo n8n / automações (API interna)
  await boss.work<OutboundJob>(QUEUES.outbound, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (job) await runOutboundJob(job.data);
  });

  // link público de agendamento: aviso do cliente perto do horário (confere se ainda vale antes de mandar)
  await boss.work<{ bookingId: string; start: string }>(QUEUES.booking, { batchSize: 1, pollingIntervalSeconds: 5 }, async ([job]) => {
    if (!job) return;
    const { runClientReminder } = await import("../booking.js");
    await runClientReminder(job.data);
  });

  // envios pedidos pelas réplicas de conversa (ROLE=conversations) a quem segura o WhatsApp
  if (config.WHATSAPP_PROVIDER === "baileys") {
    const { startChannelRpc } = await import("../whatsapp/rpc-server.js");
    await startChannelRpc(log);
  }

  // esteira de desenvolvimento do dono: uma etapa por vez, na ordem dos chamados (a espera do CI volta para a fila)
  await boss.work<{ ticketId?: number; stage?: string; attempt?: number; token?: string; sweep?: boolean; retro?: boolean }>(QUEUES.dev, { batchSize: 1, pollingIntervalSeconds: 5 }, async ([job]) => {
    if (!job) return;
    const { runStage } = await import("../devpipeline/pipeline.js");
    await runStage(job.data ?? {});
  });
  // rede de segurança: etapa parada há mais de 40 min (worker caiu no meio) volta para a fila
  await boss.schedule(QUEUES.dev, "*/10 * * * *", { sweep: true });

  // Telegram sem webhook (sem https público): só um processo pode buscar as mensagens
  startTelegramPolling(log);
}
