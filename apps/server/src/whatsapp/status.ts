import { query } from "../db/pool.js";
import { SESSION_ID, type Status } from "./types.js";

/**
 * O que o painel vê da sessão (linha de wa_sessions). As gravações de status entram numa fila e saem
 * na ordem em que aconteceram, mesmo quando quem pediu não esperou a anterior terminar.
 */
export class SessionStatus {
  private chain: Promise<unknown> = Promise.resolve();

  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  /** Grava o status do painel em ordem. down: "set" marca o início da queda, "clear" zera, "keep" mantém. */
  set(
    status: Status,
    patch: { qr?: string | null; pairing_code?: string | null; phone?: string | null; name?: string | null; last_error?: string | null } = {},
    down: "set" | "clear" | "keep" = "keep",
  ) {
    return this.queue(() =>
      query(
        `UPDATE wa_sessions SET status = $2, qr = $3, pairing_code = $4,
           phone = COALESCE($5, phone), name = COALESCE($6, name), last_error = $7,
           down_since = CASE WHEN $8 = 'clear' THEN NULL WHEN $8 = 'set' THEN COALESCE(down_since, now()) ELSE down_since END,
           updated_at = now() WHERE id = $1`,
        [SESSION_ID, status, patch.qr ?? null, patch.pairing_code ?? null, patch.phone ?? null, patch.name ?? null, patch.last_error ?? null, down],
      ),
    );
  }

  /** Conectado: mantém o painel certo (ex.: alguém gravou 'connecting' pela API e o comando não mudou nada) */
  confirmConnected() {
    return this.queue(() =>
      query(
        `UPDATE wa_sessions SET status = 'connected', qr = NULL, pairing_code = NULL, last_error = NULL, down_since = NULL, updated_at = now()
          WHERE id = $1 AND status <> 'connected'`,
        [SESSION_ID],
      ),
    );
  }

  /** Logout: esquece de quem era o número (fora da fila, depois do status já gravado). */
  forgetIdentity() {
    return query("UPDATE wa_sessions SET phone = NULL, name = NULL WHERE id = $1", [SESSION_ID]);
  }

  /** Parada pelo painel? (vale para qualquer processo que assumir a conexão depois) */
  async isStopped() {
    const r = await query<{ stopped: boolean }>("SELECT stopped_at IS NOT NULL AS stopped FROM wa_sessions WHERE id = $1", [SESSION_ID]);
    return Boolean(r.rows[0]?.stopped);
  }

  markStopped(on: boolean) {
    return this.queue(() => query(`UPDATE wa_sessions SET stopped_at = ${on ? "now()" : "NULL"} WHERE id = $1`, [SESSION_ID]));
  }

  /**
   * Painel preso em "conectando" sem nada rodando de verdade (comando perdido, tentativa que morreu):
   * volta para "desconectado" com o motivo, para aparecer o botão de gerar QR.
   */
  releaseStuck() {
    return this.queue(() =>
      query(
        `UPDATE wa_sessions SET status = 'disconnected', qr = NULL, pairing_code = NULL, down_since = NULL, updated_at = now(),
           last_error = 'A conexão não andou. Toque em Gerar QR code para tentar de novo.'
          WHERE id = $1 AND status IN ('connecting', 'reconnecting', 'qr', 'pairing') AND updated_at < now() - interval '30 seconds'`,
        [SESSION_ID],
      ),
    );
  }

  /** Termina quando tudo que estava na fila foi gravado (ou falhou). */
  settled() {
    return this.chain;
  }
}
