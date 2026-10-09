import { googleApi } from "../../integrations/google.js";
import { getCredentials } from "../../integrations/registry.js";
import { EMAIL } from "./agenda.js";
import { htmlToText } from "./research.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

export const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

const header = (msg: any, name: string) => msg.payload?.headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value;

export function bodyText(part: any): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  if (part.parts) {
    const plain = part.parts.map(bodyText).find((t: string) => t);
    if (plain) return plain;
  }
  if (part.mimeType === "text/html" && part.body?.data) return htmlToText(Buffer.from(part.body.data, "base64url").toString("utf8"));
  return "";
}

export const gmailSearch = defineTool<{ query: string; max?: number }>({
  name: "gmail_search",
  description: "Busca e-mails no Gmail (sintaxe do Gmail: from:, is:unread, newer_than:2d, subject:...).",
  integration: "google",
  parameters: obj({ query: { type: "string" }, max: { type: "number" } }, ["query"]),
  async run(args) {
    const list = await googleApi(`${GMAIL}/messages?q=${encodeURIComponent(args.query)}&maxResults=${Math.min(args.max ?? 10, 25)}`);
    const out = [];
    for (const m of list.messages ?? []) {
      const full = await googleApi(`${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
      out.push({ id: m.id, from: header(full, "From"), subject: header(full, "Subject"), date: header(full, "Date"), snippet: full.snippet, unread: full.labelIds?.includes("UNREAD") });
    }
    return out;
  },
});

export const gmailRead = defineTool<{ id: string }>({
  name: "gmail_read",
  description: "Lê o conteúdo completo de um e-mail pelo id.",
  integration: "google",
  parameters: obj({ id: { type: "string" } }, ["id"]),
  async run(args) {
    const m = await googleApi(`${GMAIL}/messages/${args.id}?format=full`);
    return { id: m.id, from: header(m, "From"), to: header(m, "To"), subject: header(m, "Subject"), date: header(m, "Date"), body: bodyText(m.payload).slice(0, 15_000) };
  },
});

export const gmailSend = defineTool<{ to: string; subject: string; body: string; confirmed_by_user?: boolean }>({
  name: "gmail_send",
  description: "Envia um e-mail pelo Gmail da pessoa. Chame com o texto final: o sistema guarda e só envia depois do \"sim\" da pessoa.",
  integration: "google",
  parameters: obj({ to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, ...CONFIRM_PARAM }, ["to", "subject", "body"]),
  async run(args, ctx) {
    // quebra de linha no cabeçalho vira cópia oculta (\r\nBcc:): recusa antes de qualquer coisa
    if (/[\r\n]/.test(args.to) || /[\r\n]/.test(args.subject)) return { ok: false, error: "Destinatário e assunto não podem ter quebra de linha" };
    const to = args.to.split(",").map((e) => e.trim()).filter(Boolean);
    if (!to.length || to.some((e) => !EMAIL.test(e))) return { ok: false, error: `E-mail inválido: ${args.to}` };
    const body = args.body.trim();
    const preview = body.length > 200 ? `${body.slice(0, 199)}…` : body;
    const c = await requireConfirmation(args, `enviar e-mail para ${to.join(", ")} com assunto "${args.subject}": "${preview}"`, ctx);
    if (c) return c;
    const subject = `=?UTF-8?B?${Buffer.from(args.subject).toString("base64")}?=`;
    const raw = [`To: ${to.join(", ")}`, `Subject: ${subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "", args.body].join("\r\n");
    const r = await googleApi(`${GMAIL}/messages/send`, { method: "POST", body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url") }) });
    return { ok: true, id: r.id };
  },
});

async function slack(method: string, params: Record<string, unknown>) {
  const creds = await getCredentials("slack");
  if (!creds) throw new Error("Slack não conectado");
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    // Form-encoded: métodos de leitura (conversations.list/history) não aceitam corpo JSON no Slack
    headers: { Authorization: `Bearer ${creds.bot_token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });
  const j: any = await res.json();
  if (!j.ok) throw new Error(`Slack ${method}: ${j.error}`);
  return j;
}

export const slackListChannels = defineTool<Record<string, never>>({
  name: "slack_list_channels",
  description: "Lista canais do Slack em que o bot está.",
  integration: "slack",
  parameters: obj({}),
  async run() {
    const j = await slack("conversations.list", { limit: 200, types: "public_channel,private_channel", exclude_archived: true });
    return j.channels.filter((c: any) => c.is_member).map((c: any) => ({ id: c.id, name: c.name }));
  },
});

export const slackReadChannel = defineTool<{ channel: string; limit?: number }>({
  name: "slack_read_channel",
  description: "Lê as mensagens recentes de um canal do Slack (id do canal).",
  integration: "slack",
  parameters: obj({ channel: { type: "string" }, limit: { type: "number" } }, ["channel"]),
  async run(args) {
    const j = await slack("conversations.history", { channel: args.channel, limit: Math.min(args.limit ?? 20, 100) });
    return j.messages.map((m: any) => ({ user: m.user, text: m.text, ts: m.ts }));
  },
});

export const slackSendMessage = defineTool<{ channel: string; text: string; confirmed_by_user?: boolean }>({
  name: "slack_send_message",
  description: "Envia mensagem num canal do Slack. O sistema guarda e só envia depois do \"sim\" da pessoa.",
  integration: "slack",
  parameters: obj({ channel: { type: "string" }, text: { type: "string" }, ...CONFIRM_PARAM }, ["channel", "text"]),
  async run(args, ctx) {
    const c = await requireConfirmation(args, `enviar no Slack (${args.channel}): "${args.text.slice(0, 80)}"`, ctx);
    if (c) return c;
    const j = await slack("chat.postMessage", { channel: args.channel, text: args.text });
    return { ok: true, ts: j.ts };
  },
});
