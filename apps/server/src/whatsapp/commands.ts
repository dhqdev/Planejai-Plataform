import type pg from "pg";
import { pool, query } from "../db/pool.js";
import type { Log, WaCommand } from "./types.js";

/** Usado pela API: manda um comando para o processo que segura a conexão. */
export async function sendWaCommand(cmd: WaCommand) {
  await query("SELECT pg_notify('wa_command', $1)", [JSON.stringify(cmd)]);
}

/** LISTEN wa_command: comandos do dashboard (API). Se a conexão do LISTEN cair, a próxima batida refaz. */
export class CommandListener {
  private client: pg.PoolClient | null = null;

  constructor(
    private readonly log: () => Log,
    private readonly onCommand: (cmd: WaCommand) => void,
  ) {}

  /** Garante o LISTEN ativo; não faz nada se já estiver escutando. */
  async ensure() {
    if (this.client) return;
    const client = await pool.connect();
    client.on("error", (err) => {
      this.log().warn({ err }, "conexão do LISTEN wa_command caiu; refaço na próxima batida");
      if (this.client === client) this.client = null;
      client.release(err);
    });
    client.on("notification", (msg) => {
      if (msg.channel !== "wa_command" || !msg.payload) return;
      this.onCommand(JSON.parse(msg.payload) as WaCommand);
    });
    try {
      await client.query("LISTEN wa_command");
    } catch (err) {
      client.release(err as Error);
      throw err;
    }
    this.client = client;
  }

  async stop() {
    if (!this.client) return;
    await this.client.query("UNLISTEN wa_command").catch(() => {});
    this.client.release();
    this.client = null;
  }
}
