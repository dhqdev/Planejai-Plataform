import { config } from "./config.js";
import { many, one, query } from "./db/pool.js";
import { phoneVariants } from "./ingest.js";

/**
 * Notificações do painel (sino com bolinha no menu). userId null = para o dono da stack.
 * Nunca derruba quem chamou: notificação é aviso.
 */
export async function notify(n: { userId: string | null; kind: string; title: string; body?: string | null; link?: string | null }) {
  try {
    await query("INSERT INTO notifications (user_id, kind, title, body, link) VALUES ($1, $2, $3, $4, $5)", [
      n.userId,
      n.kind,
      n.title.slice(0, 160),
      n.body ? String(n.body).slice(0, 600) : null,
      n.link ?? null,
    ]);
  } catch {
    /* tabela ainda não existe (boot) ou banco fora */
  }
}

/** Pessoa do WhatsApp do dono (para ele também ver as notificações pessoais dele). */
export async function ownerUserId(): Promise<string | null> {
  const phone = config.OWNER_PHONES[0];
  if (!phone) return null;
  const u = await one<{ id: string }>("SELECT id FROM users WHERE phone = ANY($1) LIMIT 1", [phoneVariants(phone)]);
  return u?.id ?? null;
}

/** Filtro de quem vê o quê: o dono vê as do sistema (user_id NULL) e as dele; cada cliente só as dele. */
async function audience(account: { owner: boolean; userId: string | null }) {
  if (account.owner) return { sql: "(user_id IS NULL OR user_id = $1)", arg: (await ownerUserId()) ?? "00000000-0000-0000-0000-000000000000" };
  return { sql: "user_id = $1", arg: account.userId ?? "00000000-0000-0000-0000-000000000000" };
}

export async function listNotifications(account: { owner: boolean; userId: string | null }, limit = 50) {
  const a = await audience(account);
  const items = await many(
    `SELECT id, kind, title, body, link, read_at, created_at FROM notifications WHERE ${a.sql} ORDER BY created_at DESC LIMIT ${Math.min(200, limit)}`,
    [a.arg],
  );
  const unread = await one<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE ${a.sql} AND read_at IS NULL`, [a.arg]);
  return { items, unread: unread?.n ?? 0 };
}

export async function unreadCount(account: { owner: boolean; userId: string | null }) {
  const a = await audience(account);
  const r = await one<{ n: number; last: string | null }>(
    `SELECT count(*)::int AS n, max(created_at) AS last FROM notifications WHERE ${a.sql} AND read_at IS NULL`,
    [a.arg],
  );
  return { unread: r?.n ?? 0, last: r?.last ?? null };
}

export async function markRead(account: { owner: boolean; userId: string | null }, ids?: number[]) {
  const a = await audience(account);
  if (ids?.length) await query(`UPDATE notifications SET read_at = now() WHERE ${a.sql} AND read_at IS NULL AND id = ANY($2)`, [a.arg, ids]);
  else await query(`UPDATE notifications SET read_at = now() WHERE ${a.sql} AND read_at IS NULL`, [a.arg]);
}
