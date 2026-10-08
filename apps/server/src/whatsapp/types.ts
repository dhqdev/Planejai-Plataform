export const SESSION_ID = "default";

export type Status = "disconnected" | "connecting" | "reconnecting" | "qr" | "pairing" | "connected";
export type Log = { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };

export interface WaCommand {
  action: "connect" | "logout" | "restart";
  /** quando informado, conecta por código de pareamento em vez de QR */
  phone?: string;
}

/** Tempos da conexão. Os padrões valem para produção; os testes encurtam. */
export interface WaTimings {
  /** renova o aluguel e confere a saúde do socket */
  heartbeatMs: number;
  /** validade do aluguel: se o processo morrer sem avisar, outro assume depois disso */
  leaseSeconds: number;
  /** ping do próprio Baileys; sem resposta em keepAlive+5s ele fecha com connectionLost */
  keepAliveMs: number;
  /** conexão aberta sem receber NADA do servidor por esse tempo = socket meio-aberto: derruba e religa */
  staleMs: number;
  /** sem QR nem conexão aberta nesse tempo = servidor não respondeu: tenta de novo */
  openTimeoutMs: number;
  /** espera entre tentativas: base * 2^tentativa, até o máximo (nunca desiste) */
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const DEFAULT_TIMINGS: WaTimings = {
  heartbeatMs: 15_000,
  leaseSeconds: 45,
  keepAliveMs: 20_000,
  staleMs: 90_000,
  openTimeoutMs: 45_000,
  backoffBaseMs: 2_000,
  backoffMaxMs: 60_000,
};
