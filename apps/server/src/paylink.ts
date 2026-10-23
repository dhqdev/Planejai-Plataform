import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { sessionSecret } from "./crypto.js";

/**
 * Link do nosso checkout (/pagar/<id>.<assinatura>) para uma cobrança do Asaas. Abre sem login (vai no WhatsApp e no
 * e-mail); a assinatura impede que alguém troque o id e veja a cobrança de outra pessoa.
 */
const sign = (id: string) => createHmac("sha256", sessionSecret()).update(`pagar:${id}`).digest("base64url").slice(0, 22);

export const payToken = (paymentId: string) => `${paymentId}.${sign(paymentId)}`;

export const payLink = (paymentId: string) => `${config.PUBLIC_URL.replace(/\/$/, "")}/pagar/${payToken(paymentId)}`;

/** Id da cobrança dentro do token, só se a assinatura confere. */
export function paymentIdOf(token: string): string | null {
  const i = String(token ?? "").lastIndexOf(".");
  if (i < 1) return null;
  const id = token.slice(0, i);
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(id)) return null;
  const got = Buffer.from(token.slice(i + 1));
  const want = Buffer.from(sign(id));
  return got.length === want.length && timingSafeEqual(got, want) ? id : null;
}

/** Link para pagar uma cobrança que veio do Asaas: o nosso quando tem id; senão o da página do Asaas. */
export const linkFor = (p: { id?: unknown; invoiceUrl?: unknown } | null | undefined): string | null =>
  p?.id ? payLink(String(p.id)) : p?.invoiceUrl ? String(p.invoiceUrl) : null;

/** Link de pagamento que pode ir para a tela: o nosso checkout ou (cobranças antigas) a página do Asaas. */
export const isPayUrl = (url: unknown) => {
  const u = String(url ?? "");
  return /^https:\/\/([a-z0-9-]+\.)*asaas\.com\//i.test(u) || u.startsWith(`${config.PUBLIC_URL.replace(/\/$/, "")}/pagar/`);
};
