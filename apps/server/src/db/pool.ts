import pg from "pg";
import { config } from "../config.js";

// numeric -> number (valores monetários pequenos, sem risco de perda de precisão relevante aqui)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// int8 -> number
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

// Cada conversa em andamento segura 1 conexão para a trava (pg_advisory_lock) enquanto o time trabalha.
// O pool cresce com WORKER_CONCURRENCY para sempre sobrar conexão para as consultas de dentro da resposta.
export const POOL_SIZE = Math.max(20, config.WORKER_CONCURRENCY * 2 + 12);
// Consulta travada cai em DB_STATEMENT_TIMEOUT_MS; quem precisa esperar mais (trava da conversa, migração) usa waitLonger().
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: POOL_SIZE,
  keepAlive: true,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 30_000,
  statement_timeout: config.DB_STATEMENT_TIMEOUT_MS || undefined,
});

/** Tira o limite de tempo desta conexão (esperar uma trava pode levar minutos); devolve o RESET para o finally. */
export async function waitLonger(client: pg.PoolClient) {
  await client.query("SET statement_timeout = 0");
  return () => client.query("RESET statement_timeout").catch(() => {});
}

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) {
  return pool.query<T>(text, params);
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) {
  const r = await pool.query<T>(text, params);
  return r.rows[0] as T | undefined;
}

export async function many<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) {
  const r = await pool.query<T>(text, params);
  return r.rows;
}
