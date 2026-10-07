import { createHmac } from "node:crypto";
import { config } from "./config.js";
import { getCredentials } from "./integrations/registry.js";

/**
 * Eventos da plataforma para o n8n (ou qualquer automação): se a integração n8n tiver "URL de eventos",
 * cada evento vai num POST JSON { event, at, data } com o cabeçalho X-Planejai-Signature (HMAC do corpo
 * com a chave interna). Nunca trava quem chamou: falhou, só registra.
 */
export type PlanejaiEvent =
  | "user.created"
  | "user.activated"
  | "transaction.created"
  | "budget.alert"
  | "reminder.fired"
  | "telegram.linked";

/** Chave da API interna. Vazia = API interna desligada (nada derivado de outro segredo). */
export function internalKey() {
  return config.INTERNAL_API_KEY;
}

export async function emitEvent(event: PlanejaiEvent, data: Record<string, unknown>) {
  try {
    const url = (await getCredentials("n8n"))?.events_url;
    // sem chave não dá para assinar: o n8n não teria como saber que veio daqui
    if (!url || !internalKey()) return;
    const body = JSON.stringify({ event, at: new Date().toISOString(), data });
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Planejai-Event": event, "X-Planejai-Signature": createHmac("sha256", internalKey()).update(body).digest("hex") },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* evento é aviso, não pode derrubar o fluxo */
  }
}
