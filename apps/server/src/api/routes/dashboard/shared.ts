import { randomBytes } from "node:crypto";
import { faceFor } from "../../../agent/team.js";
import { signSession, verifySession } from "../../../crypto.js";

/** Id no formato uuid: o que não tem esse formato nem chega ao banco (vira 404 na rota). */
export function isUuid(id: string) {
  return /^[0-9a-f-]{36}$/i.test(id);
}

/** State assinado do OAuth (vale 10 min): o callback chega do navegador sem cookie de API garantido. */
export function newOauthState() {
  return signSession({ sub: `oauth:${randomBytes(8).toString("hex")}`, exp: Date.now() + 10 * 60_000 });
}

export function isOauthState(state: string | undefined) {
  return verifySession(state)?.sub.startsWith("oauth:");
}

/** Agente criado para um cliente: sem persona usa o nome; sem carinha usa a gerada a partir de dono + slug. */
export function withLook<T extends { name: string; slug: string; persona?: string | null; face?: unknown }>(agent: T, userId: string) {
  return { ...agent, persona: agent.persona ?? agent.name, face: agent.face ?? faceFor(`${userId}:${agent.slug}`) };
}
