import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Account } from "./accounts.js";
import { normalizePhone } from "./accounts.js";
import { config } from "./config.js";
import { safeEqual } from "./crypto.js";
import { one, query } from "./db/pool.js";
import { notify } from "./notifications.js";

/**
 * Login em navegador novo: depois da senha, um código de 6 dígitos vai para o WhatsApp da pessoa.
 * Navegador que já passou pelo código guarda um cookie (pj_dev); no banco fica só o hash dele.
 */
export const DEVICE_COOKIE = "pj_dev";
const CODE_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const codeHash = (challenge: string, code: string) => sha(`${challenge}:${code}:${config.SESSION_SECRET || config.APP_SECRET}`);

export async function isTrustedDevice(accountId: string, token: string | undefined) {
  if (!token || token.length < 20) return false;
  const r = await one("UPDATE login_devices SET last_seen_at = now() WHERE account_id = $1 AND device_hash = $2 RETURNING 1", [accountId, sha(token)]);
  return Boolean(r);
}

export async function trustDevice(accountId: string, userAgent: string | undefined) {
  const token = randomBytes(24).toString("base64url");
  await query(
    "INSERT INTO login_devices (account_id, device_hash, user_agent) VALUES ($1, $2, $3) ON CONFLICT (account_id, device_hash) DO UPDATE SET last_seen_at = now()",
    [accountId, sha(token), userAgent?.slice(0, 200) ?? null],
  );
  return token;
}

/** Número que recebe o código: dono = primeiro OWNER_PHONES; cliente = celular da conta ou da pessoa ligada. */
export async function phoneFor(account: Account): Promise<string | null> {
  if (account.owner) return config.OWNER_PHONES[0] ?? null;
  if (account.phone) return normalizePhone(account.phone);
  if (account.userId) return (await one<{ phone: string }>("SELECT phone FROM users WHERE id = $1", [account.userId]))?.phone ?? null;
  return null;
}

/** Só pede código se der para entregar: senão a pessoa ficaria trancada fora (ex.: WhatsApp caiu). */
async function whatsappReady() {
  if (config.WHATSAPP_PROVIDER === "none") return false;
  if (config.WHATSAPP_PROVIDER !== "baileys") return true;
  const s = await one("SELECT 1 FROM wa_sessions WHERE status = 'connected' AND heartbeat_at > now() - interval '90 seconds'");
  return Boolean(s);
}

const mask = (p: string) => `+${p.slice(0, 2)} •••• ${p.slice(-4)}`;

export type Challenge = { needs_code: true; challenge: string; to: string } | { needs_code: false; reason: string };

export async function startChallenge(account: Account, sendCode: (phone: string, text: string) => Promise<unknown>): Promise<Challenge> {
  if (!config.LOGIN_CODE) return { needs_code: false, reason: "desligado" };
  const phone = await phoneFor(account);
  if (!phone) return { needs_code: false, reason: "sem número" };
  if (!(await whatsappReady())) {
    await notify({ userId: account.owner ? null : account.userId, kind: "seguranca", title: "Entrada sem código", body: "Um navegador novo entrou só com a senha porque o WhatsApp estava desconectado." });
    return { needs_code: false, reason: "whatsapp fora" };
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const row = await one<{ id: string }>(
    `INSERT INTO login_codes (account_id, code_hash, expires_at) VALUES ($1, 'x', now() + interval '${CODE_TTL_MIN} minutes') RETURNING id`,
    [account.id],
  );
  await query("UPDATE login_codes SET code_hash = $2 WHERE id = $1", [row!.id, codeHash(row!.id, code)]);
  await sendCode(phone, `Seu código de acesso ao painel do Planejai: ${code}\n\nVale por ${CODE_TTL_MIN} minutos. Se não foi você, ignore e troque sua senha.`);
  return { needs_code: true, challenge: row!.id, to: mask(phone) };
}

/** Confere o código. Devolve o id da conta se bateu. */
export async function verifyChallenge(challenge: string, code: string): Promise<{ ok: true; accountId: string } | { ok: false; error: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(challenge)) return { ok: false, error: "Código expirado. Entre de novo." };
  const row = await one("SELECT * FROM login_codes WHERE id = $1 AND purpose = 'login' AND used_at IS NULL AND expires_at > now()", [challenge]);
  if (!row) return { ok: false, error: "Código expirado. Entre de novo." };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: "Muitas tentativas. Entre de novo para receber outro código." };
  const clean = String(code ?? "").replace(/\D/g, "");
  if (clean.length !== 6 || !safeEqual(codeHash(row.id, clean), row.code_hash)) {
    await query("UPDATE login_codes SET attempts = attempts + 1 WHERE id = $1", [row.id]);
    return { ok: false, error: "Código errado." };
  }
  const used = await one("UPDATE login_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING account_id", [row.id]);
  if (!used) return { ok: false, error: "Código já usado." };
  return { ok: true, accountId: used.account_id };
}

/**
 * Esqueci a senha: um código de 6 dígitos vai para o WhatsApp da conta. Quem entrega é o fluxo
 * "[Sistema] Planejai · Esqueci a senha" do n8n (evento password.reset_requested); sem n8n ligado ou se ele
 * não responder, o próprio app manda pela fila de envios, para ninguém ficar trancado fora.
 * A resposta é sempre igual (com ou sem conta) para não revelar quem tem cadastro.
 */
const RESET_TTL_MIN = 15;

export async function startReset(
  account: Account | null,
  deliver: (data: { phone: string; code: string; text: string; accountId: string; userId: string | null; name: string }) => Promise<unknown>,
): Promise<{ challenge: string }> {
  const phone = account && !account.owner && account.status === "active" ? await phoneFor(account) : null;
  if (!account || !phone) return { challenge: randomUUID() };
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const row = await one<{ id: string }>(
    `INSERT INTO login_codes (account_id, code_hash, expires_at, purpose) VALUES ($1, 'x', now() + interval '${RESET_TTL_MIN} minutes', 'reset') RETURNING id`,
    [account.id],
  );
  await query("UPDATE login_codes SET code_hash = $2 WHERE id = $1", [row!.id, codeHash(row!.id, code)]);
  const text = `Seu código para criar uma senha nova no Planejai: ${code}\n\nVale por ${RESET_TTL_MIN} minutos. Se não foi você que pediu, pode ignorar: sua senha continua a mesma.`;
  await deliver({ phone, code, text, accountId: account.id, userId: account.userId ?? null, name: account.name ?? "" });
  return { challenge: row!.id };
}

/** Confere o código de "esqueci a senha". Mesma trava de tentativas do login. */
export async function verifyReset(challenge: string, code: string): Promise<{ ok: true; accountId: string } | { ok: false; error: string }> {
  const expired = { ok: false as const, error: "Código expirado. Peça outro." };
  if (!/^[0-9a-f-]{36}$/i.test(challenge)) return expired;
  const row = await one("SELECT * FROM login_codes WHERE id = $1 AND purpose = 'reset' AND used_at IS NULL AND expires_at > now()", [challenge]);
  if (!row) return { ok: false, error: "Código errado ou expirado." };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: "Muitas tentativas. Peça outro código." };
  const clean = String(code ?? "").replace(/\D/g, "");
  if (clean.length !== 6 || !safeEqual(codeHash(row.id, clean), row.code_hash)) {
    await query("UPDATE login_codes SET attempts = attempts + 1 WHERE id = $1", [row.id]);
    return { ok: false, error: "Código errado ou expirado." };
  }
  const used = await one("UPDATE login_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING account_id", [row.id]);
  if (!used) return { ok: false, error: "Código já usado." };
  return { ok: true, accountId: used.account_id };
}
