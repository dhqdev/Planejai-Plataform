import PgBoss from "pg-boss";
import { config } from "../config.js";

export const QUEUES = {
  process: "conversation.process",
  reminder: "reminder.fire",
  summarize: "conversation.summarize",
  purge: "maintenance.purge",
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
  boss = b;
  return b;
}

export async function stopBoss() {
  await boss?.stop({ graceful: true, timeout: 10_000 });
  boss = null;
}
