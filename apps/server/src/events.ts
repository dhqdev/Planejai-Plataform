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

export function internalKey() {
  return config.INTERNAL_API_KEY || createHmac("sha256", config.APP_SECRET).update("planejai-internal-api").digest("hex").slice(0, 40);
}

export async function emitEvent(event: PlanejaiEvent, data: Record<string, unknown>) {
  try {
    const url = (await getCredentials("n8n"))?.events_url;
    if (!url) return;
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
