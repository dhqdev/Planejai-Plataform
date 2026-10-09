import { BaileysChannel } from "../channels/baileys.js";
import { query } from "../db/pool.js";
import { QUEUES, getBoss } from "../queue/boss.js";
import { PgListen, RPC_DONE, RPC_WAKE, type WaRpcDone, type WaRpcJob, type WaRpcResult, findLocal } from "./rpc.js";
import { whatsapp } from "./session.js";
import type { Log } from "./types.js";

/**
 * Lado do processo que segura o WhatsApp (ROLE=channel/worker/all): executa os pedidos da fila whatsapp.send
 * vindos das réplicas de conversa e avisa o resultado por NOTIFY (ver whatsapp/rpc.ts).
 */
export async function startChannelRpc(log: Log, opts: { channel?: BaileysChannel; concurrency?: number } = {}) {
  const boss = await getBoss();
  const local = opts.channel ?? new BaileysChannel(whatsapp, false);
  const workers: string[] = [];
  // vários consumidores: um "digitando" não espera atrás de um envio aguardando a conexão voltar
  for (let i = 0; i < (opts.concurrency ?? 4); i++) {
    workers.push(
      await boss.work<WaRpcJob>(QUEUES.waRpc, { batchSize: 1, pollingIntervalSeconds: 1, includeMetadata: true }, async ([job]) => {
        if (!job) return;
        try {
          const result = await run(local, job.data);
          await done({ jobId: job.id, ok: true, result });
          return result;
        } catch (err) {
          await done({ jobId: job.id, ok: false, error: (err as Error).message });
          throw err;
        }
      }),
    );
  }
  // NOTIFY wa_rpc acorda os consumidores na hora, sem esperar a próxima leitura da fila
  const wake = new PgListen(RPC_WAKE, () => {
    for (const id of workers) boss.notifyWorker(id);
  });
  const ensure = () => wake.ensure().catch((err) => log.warn({ err }, "LISTEN wa_rpc falhou; refaço em 15s"));
  await ensure();
  const timer = setInterval(ensure, 15_000);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await wake.stop();
      for (const id of workers) await boss.offWork({ id }).catch(() => {});
    },
  };
}

async function done(d: WaRpcDone) {
  await query("SELECT pg_notify($1, $2)", [RPC_DONE, JSON.stringify(d)]).catch(() => {});
}

async function run(ch: BaileysChannel, req: WaRpcJob): Promise<WaRpcResult> {
  if (Date.now() > req.deadline) throw new Error("pedido vencido: ninguém espera mais por ele");
  switch (req.op) {
    case "text":
      return ch.sendText(req.jid, req.text, req.quotedId ? { quotedId: req.quotedId } : undefined);
    case "media":
      return ch.sendImage(req.jid, req.image);
    case "react":
      await ch.react(req.jid, req.messageId, req.emoji);
      return {};
    case "typing":
      await ch.setTyping(req.jid, req.ms);
      return {};
    case "read":
      await ch.markRead(req.jid, req.messageId);
      return {};
    case "exists":
      return { jid: await findLocal(req.variants) };
  }
}
