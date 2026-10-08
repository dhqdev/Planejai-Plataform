import PgBoss from "pg-boss";
import { config } from "../config.js";

export const QUEUES = {
  process: "conversation.process",
  reminder: "reminder.fire",
  summarize: "conversation.summarize",
  purge: "maintenance.purge",
  invite: "invite.send",
  watch: "watch.check",
  improve: "improve.daily",
  outbound: "outbound.send",
  financeDaily: "finance.daily",
} as const;

let boss: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  const b = new PgBoss({ connectionString: config.DATABASE_URL, schema: "pgboss" });
  b.on("error", (err) => console.error("[pg-boss]", err));
  await b.start();
  await b.createQueue(QUEUES.process, { name: QUEUES.process, policy: "short" });
  await b.createQueue(QUEUES.reminder, { name: QUEUES.reminder, policy: "standard" });
  await b.createQueue(QUEUES.summarize, { name: QUEUES.summarize, policy: "short" });
  await b.createQueue(QUEUES.purge, { name: QUEUES.purge, policy: "singleton" });
  await b.createQueue(QUEUES.invite, { name: QUEUES.invite, policy: "standard" });
  await b.createQueue(QUEUES.watch, { name: QUEUES.watch, policy: "singleton" });
  await b.createQueue(QUEUES.improve, { name: QUEUES.improve, policy: "singleton" });
  await b.createQueue(QUEUES.outbound, { name: QUEUES.outbound, policy: "standard" });
  await b.createQueue(QUEUES.financeDaily, { name: QUEUES.financeDaily, policy: "singleton" });
  boss = b;
  return b;
}

export async function stopBoss() {
  await boss?.stop({ graceful: true, timeout: 10_000 });
  boss = null;
}

/** Nomes amigáveis das filas para o painel. */
export const QUEUE_LABELS: Record<string, string> = {
  [QUEUES.process]: "Mensagens",
  [QUEUES.reminder]: "Lembretes",
  [QUEUES.summarize]: "Resumos",
  [QUEUES.purge]: "Limpeza",
  [QUEUES.invite]: "Convites",
  [QUEUES.watch]: "De olho",
  [QUEUES.improve]: "Reunião noturna",
  [QUEUES.outbound]: "Envios",
  [QUEUES.financeDaily]: "Contas e mensalidades",
};

/**
 * Situação das filas, como o modo fila do n8n: quantos esperando, rodando, falharam e concluíram
 * (últimas 24h), e os últimos erros. Lê direto a tabela do pg-boss, sem custo para os workers.
 */
export async function queueOverview() {
  await getBoss();
  const { many } = await import("../db/pool.js");
  const counts = await many(
    `SELECT name, state, COUNT(*)::int AS n FROM pgboss.job
      WHERE name = ANY($1) AND (state IN ('created', 'retry', 'active') OR created_on > now() - interval '24 hours')
      GROUP BY 1, 2`,
    [Object.values(QUEUES)],
  );
  const timing = await many(
    `SELECT name, ROUND(AVG(EXTRACT(EPOCH FROM (completed_on - started_on)))::numeric, 1)::float AS avg_s,
            ROUND(AVG(EXTRACT(EPOCH FROM (started_on - start_after)))::numeric, 1)::float AS wait_s
       FROM pgboss.job WHERE name = ANY($1) AND state = 'completed' AND completed_on > now() - interval '24 hours' GROUP BY 1`,
    [Object.values(QUEUES)],
  );
  const failed = await many(
    `SELECT id, name, state, retry_count, created_on, completed_on, left(COALESCE(output::text, ''), 300) AS error
       FROM pgboss.job WHERE name = ANY($1) AND state = 'failed' AND created_on > now() - interval '24 hours'
      ORDER BY created_on DESC LIMIT 20`,
    [Object.values(QUEUES)],
  );
  const queues = Object.values(QUEUES).map((name) => {
    const c = (state: string) => counts.find((r) => r.name === name && r.state === state)?.n ?? 0;
    const t = timing.find((r) => r.name === name);
    return {
      name,
      label: QUEUE_LABELS[name] ?? name,
      waiting: c("created") + c("retry"),
      active: c("active"),
      completed: c("completed"),
      failed: c("failed"),
      avgSeconds: t?.avg_s ?? null,
      waitSeconds: t?.wait_s ?? null,
    };
  });
  return { queues, failed: failed.map((f) => ({ ...f, label: QUEUE_LABELS[f.name] ?? f.name })) };
}

export async function retryJob(name: string, id: string) {
  if (!Object.values(QUEUES).includes(name as any)) throw new Error("fila desconhecida");
  await (await getBoss()).retry(name, id);
}
