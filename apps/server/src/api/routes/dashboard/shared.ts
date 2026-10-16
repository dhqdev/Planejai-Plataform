import { randomBytes } from "node:crypto";
import { faceFor } from "../../../agent/team.js";
import { signSession, verifySession } from "../../../crypto.js";
import { hit } from "../../../ratelimit.js";

/** Id no formato uuid: o que não tem esse formato nem chega ao banco (vira 404 na rota). */
export function isUuid(id: string) {
  return /^[0-9a-f-]{36}$/i.test(id);
}

/**
 * State assinado do OAuth (vale 10 min): o callback chega do navegador sem cookie de API garantido
 * (no iPhone o app instalado abre o Google numa janela com outros cookies).
 * Com userId, a conta conectada é a pessoal desse cliente (Minha conta), não a da plataforma.
 * Leva também a conta do painel que pediu: o callback recusa se outra pessoa estiver logada naquele navegador.
 */
/** Para onde volta a conexão pessoal do Google ("agenda" quando começou pela Agenda). */
export const OAUTH_BACK_COOKIE = "pj_oauth_back";

export function newOauthState(accountId: string, userId?: string) {
  return signSession({ sub: `oauth:${userId ? `u:${userId}:` : ""}a:${accountId}:${randomBytes(8).toString("hex")}`, exp: Date.now() + 10 * 60_000 });
}

/**
 * Confere o state na volta do OAuth. Recusa: state inválido ou vencido, state já usado (vale uma vez),
 * conexão pessoal na rota que só aceita a da plataforma, e navegador logado com outra conta do painel
 * (link de autorização repassado para outra pessoa: a conta dela iria parar na de quem pediu).
 */
export async function checkOauthState(state: string | undefined, current: { id: string } | null, opts: { platformOnly?: boolean } = {}) {
  const sub = verifySession(state)?.sub;
  const m = sub?.match(/^oauth:(?:u:([0-9a-f-]{36}):)?a:([\w-]{1,40}):([0-9a-f]{16})$/i);
  if (!m) return { ok: false as const, error: "state inválido" };
  const [, userId, accountId, nonce] = m;
  if (opts.platformOnly && userId) return { ok: false as const, error: "state inválido" };
  if (current && current.id !== accountId) return { ok: false as const, error: "Essa autorização foi pedida por outra conta. Abra a conexão de novo pelo seu painel." };
  if ((await hit(`oauth:state:${nonce}`, 15 * 60)) > 1) return { ok: false as const, error: "Esse link de autorização já foi usado. Comece de novo pelo painel." };
  return { ok: true as const, userId: userId ?? null };
}

/** Agente criado para um cliente: sem persona usa o nome; sem carinha usa a gerada a partir de dono + slug. */
export function withLook<T extends { name: string; slug: string; persona?: string | null; face?: unknown }>(agent: T, userId: string) {
  return { ...agent, persona: agent.persona ?? agent.name, face: agent.face ?? faceFor(`${userId}:${agent.slug}`) };
}
