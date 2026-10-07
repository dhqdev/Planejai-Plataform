import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

const keyFrom = (secret: string) => createHash("sha256").update(`enc:${secret}`).digest();

/** Chave atual (ENCRYPTION_KEY, ou o APP_SECRET legado) e as antigas que ainda abrem dados gravados antes. */
function keys(): Buffer[] {
  const current = config.ENCRYPTION_KEY || config.APP_SECRET;
  const all = [current, config.ENCRYPTION_KEY_OLD, config.APP_SECRET].filter((s, i, a) => s && a.indexOf(s) === i);
  return all.map(keyFrom);
}

/** Segredo que assina sessões e o state do OAuth (SESSION_SECRET, ou derivado do APP_SECRET legado). */
export function sessionSecret() {
  return config.SESSION_SECRET || createHmac("sha256", config.APP_SECRET).update("planejai-session").digest("hex");
}

/** Criptografa um objeto JSON com AES-256-GCM. Formato: base64(iv|tag|ciphertext). */
export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys()[0]!, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

function decryptWith(key: Buffer, buf: Buffer) {
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

/** Abre com a chave atual ou com uma antiga; `stale` diz se precisa recriptografar com a atual. */
export function decryptJsonWithInfo<T = Record<string, string>>(payload: string): { value: T; stale: boolean } {
  const buf = Buffer.from(payload, "base64");
  const list = keys();
  for (const [i, key] of list.entries()) {
    try {
      return { value: JSON.parse(decryptWith(key, buf)) as T, stale: i > 0 };
    } catch {
      /* tenta a próxima chave */
    }
  }
  throw new Error("Não consegui abrir a credencial: ENCRYPTION_KEY mudou? Coloque a anterior em ENCRYPTION_KEY_OLD.");
}

export function decryptJson<T = Record<string, string>>(payload: string): T {
  return decryptJsonWithInfo<T>(payload).value;
}

/**
 * Token de sessão assinado (HMAC) para o dashboard: base64url(payload).assinatura.
 * `v` é a versão da sessão da conta: trocar senha, sair de todos os aparelhos ou desativar aumenta a versão
 * e derruba os tokens antigos.
 */
export interface SessionPayload {
  sub: string;
  exp: number;
  v?: string;
}

export function signSession(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload?.sub !== "string" || typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  return payload;
}

export function safeEqual(a: string, b: string): boolean {
  const ha = scryptSync(a, "planejai", 32);
  const hb = scryptSync(b, "planejai", 32);
  return timingSafeEqual(ha, hb);
}
