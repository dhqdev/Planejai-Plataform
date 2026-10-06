import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

const key = () => createHash("sha256").update(`enc:${config.APP_SECRET}`).digest();

/** Criptografa um objeto JSON com AES-256-GCM. Formato: base64(iv|tag|ciphertext). */
export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

export function decryptJson<T = Record<string, string>>(payload: string): T {
  const buf = Buffer.from(payload, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  const out = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  return JSON.parse(out.toString("utf8")) as T;
}

/** Token de sessão assinado (HMAC) para o dashboard: base64url(payload).assinatura */
export function signSession(payload: { sub: string; exp: number }): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", config.APP_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(token: string | undefined): { sub: string; exp: number } | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", config.APP_SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  return payload;
}

export function safeEqual(a: string, b: string): boolean {
  const ha = scryptSync(a, "planejai", 32);
  const hb = scryptSync(b, "planejai", 32);
  return timingSafeEqual(ha, hb);
}
