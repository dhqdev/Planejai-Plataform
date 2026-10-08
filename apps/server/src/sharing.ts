import type { Account } from "./accounts.js";
import { config } from "./config.js";
import { many, one, query } from "./db/pool.js";
import { phoneVariants } from "./ingest.js";

/**
 * Telas particulares: Finanças e Agenda de cada pessoa são só dela, inclusive para o dono da plataforma.
 * Outra pessoa só vê se a dona deixar (shares), e só entre contatos (quem entrou por convite).
 */
export type ShareScope = "finance" | "agenda";
export const SHARE_SCOPES: ShareScope[] = ["finance", "agenda"];
export const SCOPE_LABEL: Record<ShareScope, string> = { finance: "Finanças", agenda: "Agenda" };

/** Ninguém: usado quando a conta não tem número ligado, para a consulta não devolver nada. */
export const NOBODY = "00000000-0000-0000-0000-000000000000";

/** Usuário de WhatsApp do dono da stack (a conta de dono do painel não tem um ligado). */
export async function ownerUserId(): Promise<string | null> {
  const phones = config.OWNER_PHONES.flatMap(phoneVariants);
  if (!phones.length) return null;
  return (await one("SELECT id FROM users WHERE phone = ANY($1) ORDER BY created_at LIMIT 1", [phones]))?.id ?? null;
}

/** A pessoa do WhatsApp por trás da conta do painel (o dono usa o primeiro OWNER_PHONES). */
export async function selfUserId(a: Pick<Account, "userId" | "owner">): Promise<string | null> {
  if (a.userId) return a.userId;
  return a.owner ? ownerUserId() : null;
}

export async function canView(ownerId: string, viewerId: string, scope: ShareScope) {
  return Boolean(await one("SELECT 1 FROM shares WHERE owner_id = $1 AND viewer_id = $2 AND scope = $3", [ownerId, viewerId, scope]));
}

/**
 * De quem são os dados que esta tela mostra: a própria pessoa, ou quem compartilhou com ela.
 * Pedido de outra pessoa sem permissão volta null (a rota responde 403).
 */
export async function personalUser(a: Account, requested: string | undefined | null, scope: ShareScope): Promise<string | null> {
  const self = (await selfUserId(a)) ?? NOBODY;
  if (!requested || requested === self) return self;
  if (!/^[0-9a-f-]{36}$/i.test(requested)) return null;
  return (await canView(requested, self, scope)) ? requested : null;
}

/** Quem compartilhou alguma tela comigo (para o seletor "Minhas / Fulano"). */
export async function sharedWithMe(viewerId: string, scope?: ShareScope) {
  return many<{ id: string; name: string; scopes: ShareScope[] }>(
    `SELECT u.id, COALESCE(u.full_name, u.name, '+' || u.phone) AS name, array_agg(s.scope ORDER BY s.scope) AS scopes
       FROM shares s JOIN users u ON u.id = s.owner_id
      WHERE s.viewer_id = $1 AND ($2::text IS NULL OR s.scope = $2) AND u.status = 'active'
      GROUP BY u.id ORDER BY 2`,
    [viewerId, scope ?? null],
  );
}

/** Meus contatos e o que cada um pode ver. */
export async function myShares(ownerId: string) {
  return many<{ id: string; name: string; phone: string; scopes: ShareScope[] }>(
    `SELECT u.id, COALESCE(u.full_name, u.name, '+' || u.phone) AS name, u.phone,
            COALESCE(array_agg(s.scope ORDER BY s.scope) FILTER (WHERE s.scope IS NOT NULL), '{}') AS scopes
       FROM contacts c JOIN users u ON u.id = c.contact_id
       LEFT JOIN shares s ON s.owner_id = c.user_id AND s.viewer_id = c.contact_id
      WHERE c.user_id = $1 AND u.status = 'active'
      GROUP BY u.id ORDER BY 2`,
    [ownerId],
  );
}

/** Liga ou desliga o que um contato pode ver. Só vale para contatos (quem aceitou o convite). */
export async function setShare(ownerId: string, viewerId: string, scope: ShareScope, on: boolean) {
  if (!SHARE_SCOPES.includes(scope)) throw new Error("Tela inválida");
  if (!/^[0-9a-f-]{36}$/i.test(viewerId)) throw new Error("Contato inválido");
  if (on) {
    const contact = await one("SELECT 1 FROM contacts WHERE user_id = $1 AND contact_id = $2", [ownerId, viewerId]);
    if (!contact) throw new Error("Só dá para compartilhar com quem já é seu contato (aceitou um convite)");
    await query("INSERT INTO shares (owner_id, viewer_id, scope) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [ownerId, viewerId, scope]);
  } else {
    await query("DELETE FROM shares WHERE owner_id = $1 AND viewer_id = $2 AND scope = $3", [ownerId, viewerId, scope]);
  }
}
