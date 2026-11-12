import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  activityUnread,
  addComment,
  createPost,
  createStatus,
  deleteComment,
  deletePost,
  deleteStatus,
  FeedError,
  findPeople,
  getPost,
  getProfile,
  leaveNetwork,
  listActivity,
  listFeed,
  listFollows,
  listLikes,
  listStatus,
  listUserPosts,
  profileOf,
  readMedia,
  report,
  saveProfile,
  setBlock,
  setFollow,
  setLike,
  statusViewers,
  suggestProfile,
  userByHandle,
  viewStatus,
} from "../../../feed.js";
import { selfUserId } from "../../../sharing.js";
import { isUuid } from "./shared.js";

const NOBODY = "00000000-0000-0000-0000-000000000000";

/**
 * Rede social (feed + status). Toda rota vale para a pessoa logada. Olhar (feed, perfis, status, busca) é livre para
 * qualquer conta do painel, mesmo sem perfil: assim o que alguém publica aparece para todo mundo. Publicar, curtir,
 * comentar, seguir e denunciar pedem o perfil criado (`needsProfile`). Quem está na conta de outra pessoa
 * ("Entrar como") só olha: escrever em nome do cliente é recusado.
 */
export function feedRoutes(base: FastifyInstance) {
  /** Pessoa por trás da conta; escrever exige o perfil criado. Responde o erro e devolve null se não der. */
  async function who(req: FastifyRequest, reply: FastifyReply, opts: { write?: boolean; profile?: boolean } = {}) {
    const uid = await selfUserId(req.account);
    if (!uid) {
      // conta sem WhatsApp ligado ainda pode olhar a rede (um id que não é de ninguém)
      if (!opts.write && opts.profile !== false) return NOBODY;
      reply.code(400).send({ error: "Conta sem WhatsApp ligado" });
      return null;
    }
    if (opts.write && req.account.impersonatedBy) {
      reply.code(403).send({ error: "Na conta de outra pessoa a rede é só para olhar." });
      return null;
    }
    if (opts.write && opts.profile !== false && !(await profileOf(uid))) {
      reply.code(403).send({ error: "Crie seu perfil para participar da rede.", needsProfile: true });
      return null;
    }
    return uid;
  }
  const isSuper = (req: FastifyRequest) => req.account.role === "superadmin" && !req.account.impersonatedBy;
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof FeedError) return reply.code(err.code).send({ error: err.message });
    throw err;
  };
  const notFound = (reply: FastifyReply, what = "Não encontrado") => reply.code(404).send({ error: what });

  base.get("/api/feed/me", async (req, reply) => {
    const uid = await who(req, reply);
    if (!uid) return;
    // sem WhatsApp ligado: só olha (não dá para criar perfil sem a pessoa por trás)
    if (uid === NOBODY) return { profile: null, canJoin: false };
    const profile = await profileOf(uid);
    if (!profile) return { profile: null, canJoin: !req.account.impersonatedBy, suggestion: await suggestProfile(uid) };
    return { profile: await getProfile(uid, profile.handle), unread: await activityUnread(uid) };
  });

  base.put<{ Body: { handle?: string; name?: string; bio?: string } }>("/api/feed/me", async (req, reply) => {
    const uid = await who(req, reply, { write: true, profile: false });
    if (!uid) return;
    try {
      const p = await saveProfile(uid, req.body ?? {});
      return { profile: await getProfile(uid, p.handle) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.delete("/api/feed/me", async (req, reply) => {
    const uid = await who(req, reply, { write: true });
    if (!uid) return;
    await leaveNetwork(uid);
    return { ok: true };
  });

  base.get<{ Querystring: { tab?: string; before?: string } }>("/api/feed", async (req, reply) => {
    const uid = await who(req, reply);
    if (!uid) return;
    return listFeed(uid, req.query.tab === "following" ? "following" : "all", req.query.before);
  });

  base.post<{ Body: { body?: string; photos?: unknown } }>("/api/feed/posts", async (req, reply) => {
    const uid = await who(req, reply, { write: true });
    if (!uid) return;
    try {
      return { post: await createPost(uid, req.body ?? {}) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.get<{ Params: { id: string } }>("/api/feed/posts/:id", async (req, reply) => {
    const uid = await who(req, reply);
    if (!uid) return;
    const r = isUuid(req.params.id) ? await getPost(uid, req.params.id, isSuper(req)) : null;
    return r ?? notFound(reply, "Publicação não encontrada");
  });

  base.delete<{ Params: { id: string } }>("/api/feed/posts/:id", async (req, reply) => {
    const uid = await who(req, reply, { write: true });
    if (!uid) return;
    if (!isUuid(req.params.id) || !(await deletePost(uid, req.params.id, isSuper(req)))) return notFound(reply, "Publicação não encontrada");
    return { ok: true };
  });

  for (const method of ["POST", "DELETE"] as const) {
    base.route<{ Params: { id: string } }>({
      method,
      url: "/api/feed/posts/:id/like",
      handler: async (req, reply) => {
        const uid = await who(req, reply, { write: true });
        if (!uid) return;
        if (!isUuid(req.params.id)) return notFound(reply);
        try {
          return await setLike(uid, req.params.id, method === "POST");
        } catch (err) {
          return fail(reply, err);
        }
      },
    });
    base.route<{ Params: { handle: string } }>({
      method,
      url: "/api/feed/u/:handle/follow",
      handler: async (req, reply) => {
        const uid = await who(req, reply, { write: true });
        if (!uid) return;
        try {
          return await setFollow(uid, req.params.handle, method === "POST");
        } catch (err) {
          return fail(reply, err);
        }
      },
    });
    base.route<{ Params: { handle: string } }>({
      method,
      url: "/api/feed/u/:handle/block",
      handler: async (req, reply) => {
        const uid = await who(req, reply, { write: true });
        if (!uid) return;
        try {
          return await setBlock(uid, req.params.handle, method === "POST");
        } catch (err) {
          return fail(reply, err);
        }
      },
    });
  }

  base.get<{ Params: { id: string } }>("/api/feed/posts/:id/likes", async (req, reply) => {
    const uid = await who(req, reply);
    if (!uid) return;
    const r = isUuid(req.params.id) ? await listLikes(uid, req.params.id) : null;
    return r ?? notFound(reply);
  });

  base.post<{ Params: { id: string }; Body: { body?: string } }>("/api/feed/posts/:id/comments", async (req, reply) => {
    const uid = await who(req, reply, { write: true });
    if (!uid) return;
    if (!isUuid(req.params.id)) return notFound(reply);
    try {
      return { comment: await addComment(uid, req.params.id, req.body?.body) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.delete<{ Params: { id: string } }>("/api/feed/comments/:id", async (req, reply) => {
    const uid = await who(req, reply, { write: true });
    if (!uid) return;
    if (!isUuid(req.params.id) || !(await deleteComment(uid, req.params.id, isSuper(req)))) return notFound(reply);
    return { ok: true };
  });

  base.get<{ Params: { handle: string }; Querystring: { before?: string } }>("/api/feed/u/:handle", async (req, reply) => {
    const uid = await who(req, reply);
    if (!uid) return;
    const profile = await getProfile(uid, req.params.handle);
    if (!profile) return notFound(reply, "Perfil não encontrado");
    return { profile, ...(profile.blocked ? { posts: [], next: null } : await listUserPosts(uid, profile.id, req.query.before)) };
  });

  for (const kind of ["followers", "following"] as const) {
    base.get<{ Params: { handle: string } }>(`/api/feed/u/:handle/${kind === "followers" ? "seguidores" : "seguindo"}`, async (req, reply) => {
      const uid = await who(req, reply);
      if (!uid) return;
      const r = await listFollows(uid, req.params.handle, kind);
      return r ?? notFound(reply, "Perfil não encontrado");
    });
  }

  base.get<{ Querystring: { q?: string } }>("/api/feed/people", async (req, reply) => {
    const uid = await who(req, reply);
    if (!uid) return;
    return findPeople(uid, String(req.query.q ?? ""));
  });

  base.get("/api/feed/activity", async (req, reply) => {
    const uid = await who(req, reply);
    if (!uid) return;
    return listActivity(uid);
  });

  base.post<{ Body: { kind?: string; id?: string; reason?: string } }>("/api/feed/report", async (req, reply) => {
    const uid = await who(req, reply, { write: true });
    if (!uid) return;
    try {
      const body = { ...(req.body ?? {}) };
      // perfil é denunciado pelo @ (a tela não conhece o id interno da pessoa)
      if (body.kind === "profile" && body.id && !isUuid(body.id)) body.id = (await userByHandle(body.id))?.user_id;
      return await report(uid, body);
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.get("/api/feed/status", async (req, reply) => {
    const uid = await who(req, reply);
    if (!uid) return;
    return listStatus(uid);
  });

  base.post<{ Body: { body?: string; bg?: string; font?: string; align?: string; photo?: unknown } }>("/api/feed/status", async (req, reply) => {
    const uid = await who(req, reply, { write: true });
    if (!uid) return;
    try {
      return await createStatus(uid, req.body ?? {});
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.post<{ Params: { id: string } }>("/api/feed/status/:id/view", async (req, reply) => {
    const uid = await who(req, reply);
    if (!uid) return;
    // quem está olhando a conta de um cliente não deixa "visto" em nome dele
    if (isUuid(req.params.id) && !req.account.impersonatedBy) await viewStatus(uid, req.params.id);
    return { ok: true };
  });

  base.get<{ Params: { id: string } }>("/api/feed/status/:id/viewers", async (req, reply) => {
    const uid = await who(req, reply);
    if (!uid) return;
    const r = isUuid(req.params.id) ? await statusViewers(uid, req.params.id) : null;
    return r ?? notFound(reply);
  });

  base.delete<{ Params: { id: string } }>("/api/feed/status/:id", async (req, reply) => {
    const uid = await who(req, reply, { write: true });
    if (!uid) return;
    if (!isUuid(req.params.id) || !(await deleteStatus(uid, req.params.id, isSuper(req)))) return notFound(reply);
    return { ok: true };
  });

  base.get<{ Params: { id: string } }>("/api/feed/media/:id", async (req, reply) => {
    const uid = await who(req, reply);
    if (!uid) return;
    const m = isUuid(req.params.id) ? await readMedia(uid, req.params.id) : null;
    if (!m) return notFound(reply);
    reply
      .header("Content-Type", m.mimetype)
      .header("Content-Disposition", "inline")
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, max-age=604800, immutable");
    return reply.send(m.data);
  });
}
