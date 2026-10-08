import { query } from "../db/pool.js";
import { SESSION_ID } from "./types.js";

/**
 * Aluguel da conexão no banco: só um processo da stack segura o WhatsApp. Quem segura renova a cada batida;
 * se morrer sem avisar, o aluguel vence e outro processo assume.
 */
export class SessionLease {
  constructor(
    private readonly holder: string,
    private readonly leaseSeconds: number,
  ) {}

  /** Assume a conexão se ninguém estiver com ela ou se o aluguel do outro processo venceu. Também renova o próprio. */
  async acquire() {
    const r = await query(
      `UPDATE wa_sessions SET holder = $2, lease_until = now() + make_interval(secs => $3), heartbeat_at = now()
        WHERE id = $1 AND (holder IS NULL OR holder = $2 OR lease_until IS NULL OR lease_until < now()) RETURNING id`,
      [SESSION_ID, this.holder, this.leaseSeconds],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Devolve o aluguel (só se ainda for deste processo), para outro assumir sem esperar vencer. */
  async release() {
    await query("UPDATE wa_sessions SET holder = NULL, lease_until = NULL WHERE id = $1 AND holder = $2", [SESSION_ID, this.holder]);
  }
}
