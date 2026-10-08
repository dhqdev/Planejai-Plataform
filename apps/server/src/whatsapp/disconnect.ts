import { DisconnectReason } from "baileys";

/** Nome legível de cada DisconnectReason do Baileys, para o log dizer por que caiu. */
const REASON_NAMES: Record<number, string> = {
  [DisconnectReason.connectionClosed]: "connectionClosed",
  [DisconnectReason.connectionLost]: "connectionLost/timedOut",
  [DisconnectReason.connectionReplaced]: "connectionReplaced",
  [DisconnectReason.loggedOut]: "loggedOut",
  [DisconnectReason.forbidden]: "forbidden",
  [DisconnectReason.badSession]: "badSession",
  [DisconnectReason.restartRequired]: "restartRequired",
  [DisconnectReason.multideviceMismatch]: "multideviceMismatch",
  [DisconnectReason.unavailableService]: "unavailableService",
};

export function statusCodeOf(err: unknown): number | undefined {
  return (err as any)?.output?.statusCode;
}

export function reasonName(code: number | undefined) {
  return code !== undefined ? REASON_NAMES[code] ?? `código ${code}` : "sem código";
}

/** Erro de envio que significa "o socket morreu por baixo" (vale derrubar, religar e tentar de novo). */
export function isConnectionError(err: unknown) {
  const code = statusCodeOf(err);
  if (code !== undefined && [428, 408, 440, 503].includes(code)) return true;
  // só erros do próprio socket do Baileys: falha ao baixar a mídia de uma URL não derruba a conexão
  return /^connection (closed|terminated|was lost|failure)/i.test((err as Error)?.message ?? "");
}
