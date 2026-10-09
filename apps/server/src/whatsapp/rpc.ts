import type pg from "pg";
import type { OutboundImage } from "../channels/types.js";
import { pool, query } from "../db/pool.js";
import { QUEUES, getBoss } from "../queue/boss.js";
import { runsChannel } from "../roles.js";
import { whatsapp } from "./session.js";

/**
 * Ponte de envio entre processos: com ROLE=conversations (ou api) o WhatsApp mora no processo ROLE=channel.
 * Por que pg-boss + NOTIFY (e não só NOTIFY): o pedido vira job da fila whatsapp.send, que é durável (channel
 * reiniciando não perde o envio), cabe mídia (NOTIFY tem limite de 8 KB) e só um processo executa. A orquestração
 * precisa do id da mensagem enviada (reação, citação, histórico), então quem pediu espera: a resposta chega por
 * NOTIFY wa_rpc_done e, se ele se perder, o próprio job é consultado no banco a cada segundo.
 * Sem nova tentativa automática (envio repetido = mensagem duplicada); pedido vencido não sai.
 */
export type WaRpc =
  | { op: "text"; jid: string; text: string; quotedId?: string }
  | { op: "media"; jid: string; image: OutboundImage }
  | { op: "react"; jid: string; messageId: string; emoji: string }
  | { op: "typing"; jid: string; ms: number }
  | { op: "read"; jid: string; messageId: string }
  | { op: "exists"; variants: string[] };

/** pedido na fila: depois do prazo o channel descarta (ninguém está mais esperando) */
export type WaRpcJob = WaRpc & { deadline: number };
export type WaRpcResult = { id?: string; jid?: string | null };
export type WaRpcDone = { jobId: string; ok: boolean; result?: WaRpcResult; error?: string };

export const RPC_WAKE = "wa_rpc";
export const RPC_DONE = "wa_rpc_done";
/** folga depois do prazo para um envio que já começou (upload de mídia) terminar */
const SLACK_MS = 60_000;

/** Este processo segura (ou disputa) a conexão do WhatsApp? Senão, envia pelo channel. */
export const holdsWhatsApp = () => runsChannel();

/** LISTEN num canal do Postgres com uma conexão dedicada; se ela cair, o próximo ensure() refaz. */
export class PgListen {
  private client: pg.PoolClient | null = null;
  private opening: Promise<void> | null = null;

  constructor(
    private readonly channel: string,
    private readonly onPayload: (payload: string) => void,
  ) {}

  async ensure() {
    if (this.client) return;
    this.opening ??= this.open().finally(() => {
      this.opening = null;
    });
    await this.opening;
  }

  private async open() {
    const client = await pool.connect();
    client.on("error", () => {
      if (this.client === client) this.client = null;
      client.release(true);
    });
    client.on("notification", (msg) => {
      if (msg.channel === this.channel) this.onPayload(msg.payload ?? "");
    });
    try {
      await client.query(`LISTEN ${this.channel}`);
    } catch (err) {
      client.release(err as Error);
      throw err;
    }
    this.client = client;
  }

  async stop() {
    const c = this.client;
    this.client = null;
    if (!c) return;
    await c.query(`UNLISTEN ${this.channel}`).catch(() => {});
    c.release();
  }
}

const pending = new Map<string, (d: WaRpcDone) => void>();
const doneListener = new PgListen(RPC_DONE, (payload) => {
  try {
    const d = JSON.parse(payload) as WaRpcDone;
    pending.get(d.jobId)?.(d);
  } catch {
    /* payload estranho: ignora */
  }
});

/** Pede ao processo channel e espera a resposta (até waitMs + folga). */
export async function callChannel(req: WaRpc, waitMs: number): Promise<WaRpcResult> {
  await doneListener.ensure().catch(() => {}); // sem LISTEN, a consulta ao job cobre
  const boss = await getBoss();
  const deadline = Date.now() + waitMs;
  const id = await boss.send(QUEUES.waRpc, { ...req, deadline } satisfies WaRpcJob, {
    retryLimit: 0,
    expireInSeconds: Math.ceil((waitMs + SLACK_MS) / 1000),
  });
  if (!id) throw new Error("pedido ao WhatsApp não entrou na fila");

  const box: { done: WaRpcDone | null; wake: () => void } = { done: null, wake: () => {} };
  pending.set(id, (d) => {
    box.done = d;
    box.wake();
  });
  try {
    await query("SELECT pg_notify($1, $2)", [RPC_WAKE, id]).catch(() => {});
    const until = deadline + SLACK_MS;
    while (!box.done && Date.now() < until) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1000);
        box.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      if (box.done) break;
      const job = await boss.getJobById<WaRpcJob>(QUEUES.waRpc, id).catch(() => null);
      if (job?.state === "completed") box.done = { jobId: id, ok: true, result: (job.output ?? {}) as WaRpcResult };
      else if (job && (job.state === "failed" || job.state === "cancelled"))
        box.done = { jobId: id, ok: false, error: String((job.output as { message?: string } | null)?.message ?? `envio ${job.state}`) };
    }
  } finally {
    pending.delete(id);
  }
  if (!box.done) {
    await boss.cancel(QUEUES.waRpc, id).catch(() => {});
    throw new Error("o processo do WhatsApp (ROLE=channel) não respondeu a tempo");
  }
  if (!box.done.ok) throw new Error(box.done.error ?? "envio falhou");
  return box.done.result ?? {};
}

/**
 * Qual variante do número (com ou sem o 9) existe no WhatsApp: jid, null (não existe) ou undefined (não deu
 * para saber: desconectado). Aqui ou no processo channel.
 */
export async function findOnWhatsApp(variants: string[]): Promise<string | null | undefined> {
  if (!holdsWhatsApp()) {
    try {
      return (await callChannel({ op: "exists", variants }, 5_000)).jid;
    } catch {
      return undefined;
    }
  }
  return findLocal(variants);
}

export async function findLocal(variants: string[]): Promise<string | null | undefined> {
  const sock = whatsapp.connected ? whatsapp.sock : null;
  if (!sock) return undefined;
  for (const v of variants) {
    try {
      const [r] = (await sock.onWhatsApp(`${v}@s.whatsapp.net`)) ?? [];
      if (r?.exists) return r.jid;
    } catch {
      /* tenta a próxima */
    }
  }
  return null;
}

export async function stopRpcClient() {
  await doneListener.stop();
}
