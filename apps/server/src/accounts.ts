import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { one } from "./db/pool.js";

export type Role = "superadmin" | "admin";

/** Quem está logado no painel. O dono da stack (ADMIN_EMAIL/ADMIN_PASSWORD) é sempre super admin. */
export interface Account {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  status: "active" | "pending" | "disabled";
  /** pessoa do WhatsApp ligada à conta: um admin só enxerga os dados dela */
  userId: string | null;
  phone: string | null;
  owner: boolean;
  /** versão da sessão: token com versão diferente não vale mais */
  sessionVersion: string;
}

export const OWNER_ID = "owner";

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const got = scryptSync(password, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(expected, got);
}

/**
 * Versão da sessão do dono: contador em settings + impressão digital da ADMIN_PASSWORD.
 * Trocar a senha na stack (ou "sair de todos os aparelhos") derruba os logins antigos dele.
 */
async function ownerSessionVersion() {
  const n = (await one("SELECT value FROM settings WHERE key = 'owner_session_version'"))?.value ?? 1;
  const fp = createHash("sha256").update(`pw:${config.ADMIN_PASSWORD}`).digest("hex").slice(0, 10);
  return `${n}.${fp}`;
}

export async function ownerAccount(): Promise<Account> {
  return {
    id: OWNER_ID,
    email: config.ADMIN_EMAIL,
    name: "Dono",
    role: "superadmin",
    status: "active",
    userId: null,
    phone: null,
    owner: true,
    sessionVersion: await ownerSessionVersion(),
  };
}

/** Derruba todos os logins da conta (troca de senha, desativação, "sair de todos os aparelhos"). */
export async function bumpSession(accountId: string) {
  if (accountId === OWNER_ID) {
    await one(
      `INSERT INTO settings (key, value, updated_at) VALUES ('owner_session_version', '2'::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = to_jsonb(COALESCE(settings.value::text::int, 1) + 1), updated_at = now() RETURNING key`,
    );
  } else {
    await one("UPDATE accounts SET session_version = session_version + 1 WHERE id = $1 RETURNING id", [accountId]);
  }
}

export function toAccount(row: any): Account {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    // só o dono da stack (ADMIN_EMAIL) é super admin: conta do banco nunca vira super admin, mesmo se o papel tiver sido gravado assim
    role: "admin",
    status: row.status,
    userId: row.user_id,
    phone: row.phone,
    owner: false,
    sessionVersion: String(row.session_version ?? 1),
  };
}

export async function loadAccount(id: string): Promise<Account | null> {
  if (id === OWNER_ID) return await ownerAccount();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const row = await one("SELECT * FROM accounts WHERE id = $1", [id]);
  return row ? toAccount(row) : null;
}

/** Normaliza celular para só dígitos com DDI (assume Brasil quando vier sem). */
export function normalizePhone(raw: string): string {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return d;
}

/** Escopo de dados: null = vê tudo (super admin); senão, só a pessoa ligada à conta. */
export function scopeUserId(a: Account): string | null {
  if (a.role === "superadmin") return null;
  // admin sem número ligado não vê dado de ninguém
  return a.userId ?? "00000000-0000-0000-0000-000000000000";
}
