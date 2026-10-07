import { createHmac } from "node:crypto";
import { config } from "./config.js";
import { getCredentials } from "./integrations/registry.js";
import { notify } from "./notifications.js";

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

/** O que cada evento vira no sino do painel (para a pessoa e/ou para o dono). */
async function toNotifications(event: PlanejaiEvent, data: Record<string, any>) {
  const uid = (data.user_id as string) ?? null;
  const name = (data.name as string) || (data.phone ? `+${data.phone}` : "Alguém");
  switch (event) {
    case "user.created":
      return notify({ userId: null, kind: "cliente", title: `Novo cliente: ${name}`, body: `Entrou pelo ${data.source ?? "convite"}.`, link: "/clients" });
    case "user.activated":
      return notify({ userId: null, kind: "cliente", title: `${name} aceitou o convite`, link: "/clients" });
    case "budget.alert":
      if (uid) await notify({ userId: uid, kind: "limite", title: "Limite de gastos", body: [].concat(data.alerts ?? []).join(" "), link: "/finance" });
      return;
    case "reminder.fired":
      if (uid) await notify({ userId: uid, kind: "lembrete", title: "Lembrete", body: data.intent ?? null, link: "/agenda" });
      return;
    case "telegram.linked":
      if (uid) await notify({ userId: uid, kind: "conexao", title: "Telegram conectado", body: data.username ? `@${data.username}` : null, link: "/profile" });
      return;
    default:
      return;
  }
}

export async function emitEvent(event: PlanejaiEvent, data: Record<string, unknown>) {
  void toNotifications(event, data as Record<string, any>).catch(() => {});
  try {
    const url = (await getCredentials("n8n"))?.events_url;
    // sem chave não dá para assinar: o n8n não teria como saber que veio daqui
    if (!url || !internalKey()) return;
    const body = JSON.stringify({ event, at: new Date().toISOString(), data });
    await fetch(url, {
      method: "POST",
      // a chave vai junto para o n8n conferir com {{ $env.PLANEJAI_API_KEY }} (o nó Crypto não faz HMAC do corpo cru)
      headers: { "Content-Type": "application/json", "X-Planejai-Event": event, "X-Planejai-Key": internalKey(), "X-Planejai-Signature": createHmac("sha256", internalKey()).update(body).digest("hex") },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* evento é aviso, não pode derrubar o fluxo */
  }
}
