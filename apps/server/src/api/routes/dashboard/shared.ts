import { randomBytes } from "node:crypto";
import { faceFor } from "../../../agent/team.js";
import { signSession, verifySession } from "../../../crypto.js";

/** Id no formato uuid: o que não tem esse formato nem chega ao banco (vira 404 na rota). */
export function isUuid(id: string) {
  return /^[0-9a-f-]{36}$/i.test(id);
}

/**
 * State assinado do OAuth (vale 10 min): o callback chega do navegador sem cookie de API garantido.
 * Com userId, a conta conectada é a pessoal desse cliente (Minha conta), não a da plataforma.
 */
export function newOauthState(userId?: string) {
  return signSession({ sub: `oauth:${userId ? `u:${userId}:` : ""}${randomBytes(8).toString("hex")}`, exp: Date.now() + 10 * 60_000 });
}

export function isOauthState(state: string | undefined) {
  return verifySession(state)?.sub.startsWith("oauth:");
}

/** Cliente dono do state (conexão pessoal) ou null (conexão da plataforma). */
export function oauthStateUser(state: string | undefined) {
  return verifySession(state)?.sub.match(/^oauth:u:([0-9a-f-]{36}):/i)?.[1] ?? null;
}

/** Agente criado para um cliente: sem persona usa o nome; sem carinha usa a gerada a partir de dono + slug. */
export function withLook<T extends { name: string; slug: string; persona?: string | null; face?: unknown }>(agent: T, userId: string) {
  return { ...agent, persona: agent.persona ?? agent.name, face: agent.face ?? faceFor(`${userId}:${agent.slug}`) };
}
