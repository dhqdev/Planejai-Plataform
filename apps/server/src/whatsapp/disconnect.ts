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

/**
 * O celular tirou este aparelho (ou a conta foi bloqueada): as credenciais salvas não valem mais e só um
 * QR novo resolve. Além de loggedOut/forbidden, o WhatsApp às vezes manda `<conflict type="device_removed"/>`
 * sem código, que o Baileys traduz como connectionReplaced (440); sem tratar, ficava religando para sempre.
 */
export function isLoggedOut(err: unknown) {
  const code = statusCodeOf(err);
  if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) return true;
  const data = (err as any)?.data;
  return data?.tag === "conflict" && data?.attrs?.type === "device_removed";
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
