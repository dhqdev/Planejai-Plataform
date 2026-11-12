import { many, one, query } from "./db/pool.js";
import { outfitsOf, type Outfit } from "./mascot.js";
import { notify } from "./notifications.js";
import { hit } from "./ratelimit.js";
import { readBlob, storeBlob } from "./storage.js";

/**
 * Rede social do Planejai (feed + status de 24h, no jeito do Instagram com o Twitter).
 *
 * Privacidade: nada da pessoa (agenda, gastos, nome do WhatsApp, telefone) entra aqui sozinho. Ela só aparece
 * para os outros depois de criar o perfil, com o @ e o nome que escolher, e só o que ela mesma publica é visto.
 * O avatar é o Bolinho dela (ninguém sobe foto de perfil). Quem bloqueia some para o bloqueado e vice-versa.
 * Sem IA: nenhuma rota daqui chama modelo nem gasta grão.
 */

export const POST_MAX = 500;
export const COMMENT_MAX = 300;
export const STATUS_MAX = 220;
export const BIO_MAX = 160;
export const MAX_PHOTOS = 4;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PAGE = 20;

/** Fundos do status de texto (as cores moram no CSS do painel; aqui só os nomes aceitos). */
export const STATUS_BGS = ["tinta", "roxo", "magenta", "ceu", "mata", "sol", "noite", "lilas", "areia", "rosa", "mar", "vinho"] as const;
/** Fontes e alinhamento do status de texto (o desenho de cada fonte mora no CSS do painel). */
export const STATUS_FONTS = ["classica", "forte", "serifa", "maquina", "leve"] as const;
export const STATUS_ALIGNS = ["center", "left", "right"] as const;

const RESERVED = new Set(["planejai", "planejai.oficial", "admin", "suporte", "ajuda", "oficial", "sistema", "moderacao", "feed", "status", "rede", "api", "eu", "me"]);

export class FeedError extends Error {
  constructor(message: string, public code = 400) {
    super(message);
  }
}

export interface FeedProfile {
  user_id: string;
  handle: string;
  name: string;
  bio: string;
  created_at: string;
}
export interface Author {
  id: string;
  handle: string;
  name: string;
  outfit: Outfit | null;
  /** perfil oficial do Planejai (selo de verificado) */
  official: boolean;
}
export interface PhotoIn {
  base64?: string;
  mimetype?: string;
  width?: number;
  height?: number;
}

const clean = (s: unknown, max: number) =>
  String(s ?? "")
    // sem caracteres de controle (menos quebra de linha) nem mais de duas linhas vazias seguidas
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
const oneLine = (s: unknown, max: number) => clean(s, max * 2).replace(/\s+/g, " ").slice(0, max).trim();

/** @ da pessoa: 3 a 20 letras minúsculas, números, ponto ou sublinhado; começa por letra ou número. */
export function normalizeHandle(raw: unknown) {
  return String(raw ?? "")
    .trim()
    .replace(/^@+/, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "");
}
export function handleProblem(handle: string): string | null {
  if (handle.length < 3) return "O @ precisa de pelo menos 3 letras.";
  if (handle.length > 20) return "O @ pode ter até 20 letras.";
  if (!/^[a-z0-9][a-z0-9._]*$/.test(handle)) return "Use só letras, números, ponto e sublinhado no @.";
  if (/[._]{2}|[._]$/.test(handle)) return "O @ não pode terminar com ponto nem ter dois seguidos.";
  if (RESERVED.has(handle)) return "Esse @ não está disponível.";
  return null;
}

export async function profileOf(userId: string) {
  return one<FeedProfile>("SELECT user_id, handle, name, bio, created_at FROM feed_profiles WHERE user_id = $1", [userId]);
}

/** Sugestão de @ e nome para quem ainda não entrou (só o primeiro nome; a pessoa troca antes de salvar). */
export async function suggestProfile(userId: string) {
  const u = await one<{ name: string | null; full_name: string | null }>("SELECT name, full_name FROM users WHERE id = $1", [userId]);
  const name = oneLine(u?.name || u?.full_name || "", 40).split(" ")[0] ?? "";
  let base = normalizeHandle(name).replace(/[^a-z0-9]/g, "").slice(0, 14);
  if (base.length < 3 || RESERVED.has(base)) base = "";
  let handle = base;
  for (let i = 0; base && i < 6; i++) {
    if (!(await one("SELECT 1 FROM feed_profiles WHERE lower(handle) = $1", [handle]))) break;
    handle = `${base}${Math.floor(10 + Math.random() * 990)}`;
  }
  return { handle, name };
}

export async function saveProfile(userId: string, input: { handle?: unknown; name?: unknown; bio?: unknown }) {
  const handle = normalizeHandle(input.handle);
  const problem = handleProblem(handle);
  if (problem) throw new FeedError(problem);
  const name = oneLine(input.name, 40);
  if (name.length < 2) throw new FeedError("Escreva o nome que vai aparecer no seu perfil.");
  const bio = clean(input.bio, BIO_MAX);
  const taken = await one("SELECT 1 FROM feed_profiles WHERE lower(handle) = $1 AND user_id <> $2", [handle, userId]);
  if (taken) throw new FeedError("Esse @ já é de outra pessoa. Tente outro.", 409);
  const isNew = !(await profileOf(userId));
  try {
    await query(
      `INSERT INTO feed_profiles (user_id, handle, name, bio) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET handle = EXCLUDED.handle, name = EXCLUDED.name, bio = EXCLUDED.bio`,
      [userId, handle, name, bio],
    );
    // quem entra já segue o Planejai: a aba Seguindo nasce com alguma coisa
    if (isNew)
      await query(
        `INSERT INTO feed_follows (follower_id, followed_id) SELECT $1, user_id FROM feed_profiles WHERE official AND user_id <> $1 ON CONFLICT DO NOTHING`,
        [userId],
      );
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new FeedError("Esse @ já é de outra pessoa. Tente outro.", 409);
    throw err;
  }
  return (await profileOf(userId))!;
}

/** Sair da rede: apaga o perfil e, em cascata, posts, status, curtidas, comentários e seguidores. */
export async function leaveNetwork(userId: string) {
  await query("DELETE FROM feed_profiles WHERE user_id = $1", [userId]);
}

/** Trecho SQL: `col` não bloqueou `$n` nem foi bloqueado por ele. */
const notBlocked = (col: string, n: number) =>
  `NOT EXISTS (SELECT 1 FROM feed_blocks fb WHERE (fb.blocker_id = $${n} AND fb.blocked_id = ${col}) OR (fb.blocker_id = ${col} AND fb.blocked_id = $${n}))`;

async function authors(ids: string[]): Promise<Map<string, Author>> {
  const uniq = [...new Set(ids)];
  const out = new Map<string, Author>();
  if (!uniq.length) return out;
  const [rows, outfits] = await Promise.all([
    many<{ user_id: string; handle: string; name: string; official: boolean }>("SELECT user_id, handle, name, official FROM feed_profiles WHERE user_id = ANY($1)", [uniq]),
    outfitsOf(uniq),
  ]);
  for (const r of rows) out.set(r.user_id, { id: r.user_id, handle: r.handle, name: r.name, outfit: outfits.get(r.user_id) ?? null, official: r.official });
  return out;
}

interface PostRow {
  id: string;
  user_id: string;
  body: string;
  card: string | null;
  link_url: string | null;
  link_title: string | null;
  link_desc: string | null;
  created_at: string;
  likes: number;
  comments: number;
  liked: boolean;
  liker: string | null;
}
const POST_COLS = `p.id, p.user_id, p.body, p.card, p.link_url, p.link_title, p.link_desc, p.created_at,
  (SELECT count(*)::int FROM feed_likes l WHERE l.post_id = p.id) AS likes,
  (SELECT fp.handle FROM feed_likes l JOIN feed_profiles fp ON fp.user_id = l.user_id
    WHERE l.post_id = p.id AND l.user_id <> $1 AND ${notBlocked("l.user_id", 1)} ORDER BY l.created_at DESC LIMIT 1) AS liker,
  (SELECT count(*)::int FROM feed_comments c WHERE c.post_id = p.id AND ${notBlocked("c.user_id", 1)}) AS comments,
  EXISTS (SELECT 1 FROM feed_likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked`;

async function hydrate(me: string, rows: PostRow[]) {
  const ids = rows.map((r) => r.id);
  const [who, media] = await Promise.all([
    authors(rows.map((r) => r.user_id)),
    ids.length
      ? many<{ id: string; post_id: string; width: number; height: number }>("SELECT id, post_id, width, height FROM feed_media WHERE post_id = ANY($1) ORDER BY pos", [ids])
      : Promise.resolve([]),
  ]);
  return rows
    .filter((r) => who.has(r.user_id))
    .map((r) => ({
      id: r.id,
      body: r.body,
      card: r.card,
      link: r.link_url ? { url: r.link_url, title: r.link_title ?? "", desc: r.link_desc ?? "" } : null,
      created_at: r.created_at,
      author: who.get(r.user_id)!,
      media: media.filter((m) => m.post_id === r.id).map((m) => ({ id: m.id, w: m.width, h: m.height })),
      likes: r.likes,
      comments: r.comments,
      liked: r.liked,
      liker: r.liker,
      mine: r.user_id === me,
    }));
}

const beforeDate = (before?: string) => {
  const d = before ? new Date(before) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};

/** Feed: "all" traz todo mundo (mais novo primeiro); "following" só quem a pessoa segue e ela mesma. */
export async function listFeed(me: string, tab: "all" | "following", before?: string) {
  const rows = await many<PostRow>(
    `SELECT ${POST_COLS} FROM feed_posts p
      WHERE ($2::timestamptz IS NULL OR p.created_at < $2)
        AND ${notBlocked("p.user_id", 1)}
        ${tab === "following" ? "AND (p.user_id = $1 OR p.user_id IN (SELECT followed_id FROM feed_follows WHERE follower_id = $1))" : ""}
      ORDER BY p.created_at DESC LIMIT ${PAGE + 1}`,
    [me, beforeDate(before)],
  );
  const page = rows.slice(0, PAGE);
  return { posts: await hydrate(me, page), next: rows.length > PAGE ? page[page.length - 1]!.created_at : null };
}

export async function listUserPosts(me: string, userId: string, before?: string) {
  const rows = await many<PostRow>(
    `SELECT ${POST_COLS} FROM feed_posts p
      WHERE p.user_id = $2 AND ($3::timestamptz IS NULL OR p.created_at < $3) AND ${notBlocked("p.user_id", 1)}
      ORDER BY p.created_at DESC LIMIT ${PAGE + 1}`,
    [me, userId, beforeDate(before)],
  );
  const page = rows.slice(0, PAGE);
  return { posts: await hydrate(me, page), next: rows.length > PAGE ? page[page.length - 1]!.created_at : null };
}

async function visiblePost(me: string, id: string) {
  return one<PostRow>(`SELECT ${POST_COLS} FROM feed_posts p WHERE p.id = $2 AND ${notBlocked("p.user_id", 1)}`, [me, id]);
}

export async function getPost(me: string, id: string, isSuper = false) {
  const row = await visiblePost(me, id);
  if (!row) return null;
  const [post] = await hydrate(me, [row]);
  if (!post) return null;
  const rows = await many<{ id: string; user_id: string; body: string; created_at: string }>(
    `SELECT c.id, c.user_id, c.body, c.created_at FROM feed_comments c
      WHERE c.post_id = $2 AND ${notBlocked("c.user_id", 1)} ORDER BY c.created_at LIMIT 300`,
    [me, id],
  );
  const who = await authors(rows.map((r) => r.user_id));
  const comments = rows
    .filter((r) => who.has(r.user_id))
    .map((r) => ({ id: r.id, body: r.body, created_at: r.created_at, author: who.get(r.user_id)!, mine: r.user_id === me, canDelete: r.user_id === me || post.mine || isSuper }));
  return { post, comments };
}

/** Confere o tipo pelo começo do arquivo (não pelo que o navegador disse). */
function sniffImage(data: Buffer): string | null {
  if (data.length < 12) return null;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

function readPhotos(input: unknown, max: number) {
  const list = Array.isArray(input) ? (input as PhotoIn[]) : [];
  if (list.length > max) throw new FeedError(max === 1 ? "Só uma foto por status." : `Até ${max} fotos por publicação.`);
  return list.map((p) => {
    const raw = typeof p?.base64 === "string" ? p.base64.replace(/^data:[^,]*,/, "") : "";
    const data = Buffer.from(raw, "base64");
    if (data.length > MAX_PHOTO_BYTES) throw new FeedError("Foto grande demais (até 2 MB cada).", 413);
    const mimetype = sniffImage(data);
    if (!mimetype) throw new FeedError("Só fotos em JPG, PNG ou WebP.");
    const dim = (v: unknown) => Math.min(8000, Math.max(0, Math.round(Number(v) || 0)));
    return { data, mimetype, width: dim(p.width), height: dim(p.height) };
  });
}

async function savePhotos(owner: { post_id?: string; status_id?: string }, photos: ReturnType<typeof readPhotos>) {
  let pos = 0;
  for (const p of photos) {
    const row = await one<{ id: string }>(
      "INSERT INTO feed_media (post_id, status_id, pos, mimetype, width, height, size) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [owner.post_id ?? null, owner.status_id ?? null, pos++, p.mimetype, p.width, p.height, p.data.length],
    );
    const blob = await storeBlob(`arquivos/rede/${row!.id}`, p.data, p.mimetype);
    await query("UPDATE feed_media SET data = $2, storage_key = $3 WHERE id = $1", [row!.id, blob.data, blob.storage_key]);
  }
}

/** Largura e altura de JPEG, PNG ou WebP lendo só o cabeçalho (0 se não reconhecer). */
export function imageSize(data: Buffer): { width: number; height: number } {
  try {
    if (data[0] === 0x89 && data[1] === 0x50) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    if (data.subarray(0, 4).toString("latin1") === "RIFF") {
      const kind = data.subarray(12, 16).toString("latin1");
      if (kind === "VP8X") return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
      if (kind === "VP8 ") return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
      if (kind === "VP8L") {
        const b = data.readUInt32LE(21);
        return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
      }
    }
    if (data[0] === 0xff && data[1] === 0xd8) {
      let i = 2;
      while (i + 9 < data.length) {
        if (data[i] !== 0xff) return { width: 0, height: 0 };
        const marker = data[i + 1]!;
        const len = data.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
          return { width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
  } catch {
    /* cabeçalho estranho */
  }
  return { width: 0, height: 0 };
}

/** Foto que o próprio servidor publica (post ou status do perfil oficial): confere o tipo e mede pelo cabeçalho. */
export async function attachServerPhoto(owner: { post_id?: string; status_id?: string }, data: Buffer) {
  const mimetype = sniffImage(data);
  if (!mimetype) throw new FeedError("Imagem em formato que a rede não mostra.");
  await savePhotos(owner, [{ data: Buffer.from(data), mimetype, ...imageSize(data) }]);
}

async function limit(userId: string, what: string, max: number, message: string) {
  if ((await hit(`feed:${what}:${userId}`, 86_400)) > max) throw new FeedError(message, 429);
}

export async function createPost(me: string, input: { body?: unknown; photos?: unknown }) {
  const body = clean(input.body, POST_MAX);
  const photos = readPhotos(input.photos, MAX_PHOTOS);
  if (!body && !photos.length) throw new FeedError("Escreva alguma coisa ou escolha uma foto.");
  await limit(me, "post", 40, "Você já publicou bastante hoje. Tente de novo amanhã.");
  const row = await one<{ id: string }>("INSERT INTO feed_posts (user_id, body) VALUES ($1, $2) RETURNING id", [me, body]);
  try {
    await savePhotos({ post_id: row!.id }, photos);
  } catch (err) {
    await query("DELETE FROM feed_posts WHERE id = $1", [row!.id]);
    throw err;
  }
  return (await getPost(me, row!.id))!.post;
}

/** Apaga o próprio post; o super admin apaga qualquer um (moderação). */
export async function deletePost(me: string, id: string, isSuper: boolean) {
  const r = await query(`DELETE FROM feed_posts WHERE id = $1 AND (user_id = $2 OR $3)`, [id, me, isSuper]);
  return (r.rowCount ?? 0) > 0;
}

export async function setLike(me: string, id: string, on: boolean) {
  if (!(await visiblePost(me, id))) throw new FeedError("Publicação não encontrada.", 404);
  if (on) await query("INSERT INTO feed_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, me]);
  else await query("DELETE FROM feed_likes WHERE post_id = $1 AND user_id = $2", [id, me]);
  const n = await one<{ n: number }>("SELECT count(*)::int AS n FROM feed_likes WHERE post_id = $1", [id]);
  return { liked: on, likes: n?.n ?? 0 };
}

export async function listLikes(me: string, id: string) {
  if (!(await visiblePost(me, id))) return null;
  const rows = await many<{ user_id: string }>(
    `SELECT l.user_id FROM feed_likes l WHERE l.post_id = $2 AND ${notBlocked("l.user_id", 1)} ORDER BY l.created_at DESC LIMIT 200`,
    [me, id],
  );
  return people(me, rows.map((r) => r.user_id));
}

export async function addComment(me: string, postId: string, raw: unknown) {
  const body = clean(raw, COMMENT_MAX);
  if (!body) throw new FeedError("Escreva o comentário.");
  if (!(await visiblePost(me, postId))) throw new FeedError("Publicação não encontrada.", 404);
  await limit(me, "comment", 300, "Você já comentou bastante hoje. Tente de novo amanhã.");
  const row = await one<{ id: string; created_at: string }>("INSERT INTO feed_comments (post_id, user_id, body) VALUES ($1, $2, $3) RETURNING id, created_at", [postId, me, body]);
  const who = await authors([me]);
  return { id: row!.id, body, created_at: row!.created_at, author: who.get(me)!, mine: true, canDelete: true };
}

/** Sai o comentário de quem escreveu, do dono do post ou pelo super admin. */
export async function deleteComment(me: string, id: string, isSuper: boolean) {
  const r = await query(
    `DELETE FROM feed_comments c USING feed_posts p WHERE c.id = $1 AND p.id = c.post_id AND (c.user_id = $2 OR p.user_id = $2 OR $3)`,
    [id, me, isSuper],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Lista de pessoas (curtidas, seguidores, busca) com "sigo?" já marcado, na ordem recebida. */
async function people(me: string, ids: string[]) {
  const who = await authors(ids);
  const mine = ids.length ? await many<{ followed_id: string }>("SELECT followed_id FROM feed_follows WHERE follower_id = $1 AND followed_id = ANY($2)", [me, ids]) : [];
  const following = new Set(mine.map((r) => r.followed_id));
  const bios = ids.length ? await many<{ user_id: string; bio: string }>("SELECT user_id, bio FROM feed_profiles WHERE user_id = ANY($1)", [ids]) : [];
  const bio = new Map(bios.map((b) => [b.user_id, b.bio]));
  return ids.filter((id) => who.has(id)).map((id) => ({ ...who.get(id)!, bio: bio.get(id) ?? "", following: following.has(id), me: id === me }));
}

export async function userByHandle(handle: string) {
  return one<FeedProfile>("SELECT user_id, handle, name, bio, created_at FROM feed_profiles WHERE lower(handle) = $1", [normalizeHandle(handle)]);
}

export async function getProfile(me: string, handle: string) {
  const p = await userByHandle(handle);
  if (!p) return null;
  const blockedByThem = Boolean(await one("SELECT 1 FROM feed_blocks WHERE blocker_id = $1 AND blocked_id = $2", [p.user_id, me]));
  if (blockedByThem) return null;
  const [c, rel, who] = await Promise.all([
    one<{ posts: number; followers: number; following: number }>(
      `SELECT (SELECT count(*)::int FROM feed_posts WHERE user_id = $1) AS posts,
              (SELECT count(*)::int FROM feed_follows WHERE followed_id = $1) AS followers,
              (SELECT count(*)::int FROM feed_follows WHERE follower_id = $1) AS following`,
      [p.user_id],
    ),
    one<{ following: boolean; follows_me: boolean; blocked: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM feed_follows WHERE follower_id = $1 AND followed_id = $2) AS following,
              EXISTS (SELECT 1 FROM feed_follows WHERE follower_id = $2 AND followed_id = $1) AS follows_me,
              EXISTS (SELECT 1 FROM feed_blocks WHERE blocker_id = $1 AND blocked_id = $2) AS blocked`,
      [me, p.user_id],
    ),
    authors([p.user_id]),
  ]);
  return {
    ...who.get(p.user_id)!,
    bio: p.bio,
    since: p.created_at,
    posts: c?.posts ?? 0,
    followers: c?.followers ?? 0,
    following: c?.following ?? 0,
    me: p.user_id === me,
    iFollow: rel?.following ?? false,
    followsMe: rel?.follows_me ?? false,
    blocked: rel?.blocked ?? false,
  };
}

export async function setFollow(me: string, handle: string, on: boolean) {
  const p = await userByHandle(handle);
  if (!p || p.user_id === me) throw new FeedError("Perfil não encontrado.", 404);
  if (on) {
    const blocked = await one("SELECT 1 FROM feed_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)", [me, p.user_id]);
    if (blocked) throw new FeedError("Não dá para seguir esse perfil.", 403);
    await limit(me, "follow", 400, "Muita gente seguida hoje. Tente de novo amanhã.");
    await query("INSERT INTO feed_follows (follower_id, followed_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [me, p.user_id]);
  } else {
    await query("DELETE FROM feed_follows WHERE follower_id = $1 AND followed_id = $2", [me, p.user_id]);
  }
  return { following: on };
}

/** Bloquear: os dois deixam de se seguir e um não vê mais nada do outro. */
export async function setBlock(me: string, handle: string, on: boolean) {
  const p = await userByHandle(handle);
  if (!p || p.user_id === me) throw new FeedError("Perfil não encontrado.", 404);
  if (on) {
    await query("INSERT INTO feed_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [me, p.user_id]);
    await query("DELETE FROM feed_follows WHERE (follower_id = $1 AND followed_id = $2) OR (follower_id = $2 AND followed_id = $1)", [me, p.user_id]);
  } else {
    await query("DELETE FROM feed_blocks WHERE blocker_id = $1 AND blocked_id = $2", [me, p.user_id]);
  }
  return { blocked: on };
}

export async function listFollows(me: string, handle: string, kind: "followers" | "following") {
  const p = await getProfile(me, handle);
  if (!p) return null;
  const [mineCol, otherCol] = kind === "followers" ? ["followed_id", "follower_id"] : ["follower_id", "followed_id"];
  const rows = await many<{ id: string }>(
    `SELECT f.${otherCol} AS id FROM feed_follows f WHERE f.${mineCol} = $2 AND ${notBlocked(`f.${otherCol}`, 1)} ORDER BY f.created_at DESC LIMIT 300`,
    [me, p.id],
  );
  return people(me, rows.map((r) => r.id));
}

/** Busca por @ ou nome; sem texto, sugere quem a pessoa ainda não segue (os mais seguidos primeiro). */
export async function findPeople(me: string, q: string, max = 20) {
  const term = oneLine(q, 40).replace(/^@/, "").toLowerCase();
  const rows = term
    ? await many<{ user_id: string }>(
        `SELECT p.user_id FROM feed_profiles p
          WHERE p.user_id <> $1 AND (lower(p.handle) LIKE $2 OR lower(p.name) LIKE $2) AND ${notBlocked("p.user_id", 1)}
          ORDER BY (lower(p.handle) = $3) DESC, (lower(p.handle) LIKE $4) DESC, p.name LIMIT ${max}`,
        [me, `%${term.replace(/[\\%_]/g, "\\$&")}%`, term, `${term.replace(/[\\%_]/g, "\\$&")}%`],
      )
    : await many<{ user_id: string }>(
        `SELECT p.user_id FROM feed_profiles p
          WHERE p.user_id <> $1 AND ${notBlocked("p.user_id", 1)}
            AND NOT EXISTS (SELECT 1 FROM feed_follows f WHERE f.follower_id = $1 AND f.followed_id = p.user_id)
          ORDER BY (SELECT count(*) FROM feed_follows f WHERE f.followed_id = p.user_id) DESC, p.created_at DESC LIMIT ${max}`,
        [me],
      );
  return people(me, rows.map((r) => r.user_id));
}

const ACTIVITY_SQL = `
  SELECT 'like' AS kind, l.user_id AS actor, l.post_id, NULL::text AS text, l.created_at
    FROM feed_likes l JOIN feed_posts p ON p.id = l.post_id WHERE p.user_id = $1 AND l.user_id <> $1
  UNION ALL
  SELECT 'comment', c.user_id, c.post_id, c.body, c.created_at
    FROM feed_comments c JOIN feed_posts p ON p.id = c.post_id WHERE p.user_id = $1 AND c.user_id <> $1
  UNION ALL
  SELECT 'follow', f.follower_id, NULL::uuid, NULL::text, f.created_at FROM feed_follows f WHERE f.followed_id = $1`;

export async function activityUnread(me: string) {
  const r = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM (${ACTIVITY_SQL}) a
      WHERE a.created_at > (SELECT activity_seen_at FROM feed_profiles WHERE user_id = $1) AND ${notBlocked("a.actor", 1)}`,
    [me],
  );
  return r?.n ?? 0;
}

/** Atividade: quem curtiu, comentou ou começou a seguir. Abrir a tela marca tudo como visto. */
export async function listActivity(me: string) {
  const seen = (await one<{ activity_seen_at: string }>("SELECT activity_seen_at FROM feed_profiles WHERE user_id = $1", [me]))?.activity_seen_at;
  const rows = await many<{ kind: "like" | "comment" | "follow"; actor: string; post_id: string | null; text: string | null; created_at: string }>(
    `SELECT * FROM (${ACTIVITY_SQL}) a WHERE ${notBlocked("a.actor", 1)} ORDER BY a.created_at DESC LIMIT 80`,
    [me],
  );
  await query("UPDATE feed_profiles SET activity_seen_at = now() WHERE user_id = $1", [me]);
  const who = await people(me, [...new Set(rows.map((r) => r.actor))]);
  const by = new Map(who.map((w) => [w.id, w]));
  const postIds = [...new Set(rows.map((r) => r.post_id).filter((id): id is string => !!id))];
  const posts = postIds.length ? await many<{ id: string; body: string }>("SELECT id, body FROM feed_posts WHERE id = ANY($1)", [postIds]) : [];
  const excerpt = new Map(posts.map((p) => [p.id, p.body.slice(0, 80)]));
  return rows
    .filter((r) => by.has(r.actor))
    .map((r) => ({
      kind: r.kind,
      actor: by.get(r.actor)!,
      post_id: r.post_id,
      post: r.post_id ? (excerpt.get(r.post_id) ?? "") : null,
      text: r.text ? r.text.slice(0, 140) : null,
      created_at: r.created_at,
      unread: seen ? new Date(r.created_at) > new Date(seen) : false,
    }));
}

// ---------- Status (24h) ----------

/** Status no ar, agrupados por pessoa: os meus primeiro, depois quem tem coisa que ainda não vi (quem eu sigo antes). */
export async function listStatus(me: string) {
  const rows = await many<{ id: string; user_id: string; kind: "text" | "photo"; body: string; bg: string; font: string; align: string; created_at: string; expires_at: string; seen: boolean; views: number; followed: boolean }>(
    `SELECT s.id, s.user_id, s.kind, s.body, s.bg, s.font, s.align, s.created_at, s.expires_at,
            (s.user_id = $1 OR EXISTS (SELECT 1 FROM feed_status_views v WHERE v.status_id = s.id AND v.user_id = $1)) AS seen,
            (SELECT count(*)::int FROM feed_status_views v WHERE v.status_id = s.id AND v.user_id <> s.user_id) AS views,
            EXISTS (SELECT 1 FROM feed_follows f WHERE f.follower_id = $1 AND f.followed_id = s.user_id) AS followed
       FROM feed_status s
      WHERE s.expires_at > now() AND ${notBlocked("s.user_id", 1)}
      ORDER BY s.created_at LIMIT 600`,
    [me],
  );
  const ids = rows.map((r) => r.id);
  const [who, media] = await Promise.all([
    authors(rows.map((r) => r.user_id)),
    ids.length ? many<{ id: string; status_id: string; width: number; height: number }>("SELECT id, status_id, width, height FROM feed_media WHERE status_id = ANY($1)", [ids]) : Promise.resolve([]),
  ]);
  const photo = new Map(media.map((m) => [m.status_id, { id: m.id, w: m.width, h: m.height }]));
  const groups = new Map<string, { author: Author; me: boolean; followed: boolean; seen: boolean; last: string; items: any[] }>();
  for (const r of rows) {
    const author = who.get(r.user_id);
    if (!author) continue;
    const g = groups.get(r.user_id) ?? { author, me: r.user_id === me, followed: r.followed, seen: true, last: r.created_at, items: [] };
    g.items.push({ id: r.id, kind: r.kind, body: r.body, bg: r.bg, font: r.font, align: r.align, media: photo.get(r.id) ?? null, created_at: r.created_at, expires_at: r.expires_at, seen: r.seen, views: r.user_id === me ? r.views : undefined });
    g.seen = g.seen && r.seen;
    g.last = r.created_at;
    groups.set(r.user_id, g);
  }
  const rank = (g: { me: boolean; seen: boolean; followed: boolean }) => (g.me ? 0 : (g.seen ? 2 : 0) + (g.followed ? 1 : 2));
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || (a.last < b.last ? 1 : -1)).slice(0, 60);
}

export async function createStatus(me: string, input: { body?: unknown; bg?: unknown; font?: unknown; align?: unknown; photo?: unknown }) {
  const body = clean(input.body, STATUS_MAX);
  const photos = readPhotos(input.photo ? [input.photo] : [], 1);
  if (!body && !photos.length) throw new FeedError("Escreva alguma coisa ou escolha uma foto.");
  const bg = STATUS_BGS.includes(input.bg as (typeof STATUS_BGS)[number]) ? String(input.bg) : "tinta";
  await limit(me, "status", 30, "Você já postou bastante status hoje. Tente de novo amanhã.");
  const font = STATUS_FONTS.includes(input.font as (typeof STATUS_FONTS)[number]) ? String(input.font) : "classica";
  const align = STATUS_ALIGNS.includes(input.align as (typeof STATUS_ALIGNS)[number]) ? String(input.align) : "center";
  const row = await one<{ id: string }>("INSERT INTO feed_status (user_id, kind, body, bg, font, align) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id", [
    me,
    photos.length ? "photo" : "text",
    body,
    bg,
    font,
    align,
  ]);
  try {
    await savePhotos({ status_id: row!.id }, photos);
  } catch (err) {
    await query("DELETE FROM feed_status WHERE id = $1", [row!.id]);
    throw err;
  }
  return { id: row!.id };
}

export async function viewStatus(me: string, id: string) {
  await query(
    `INSERT INTO feed_status_views (status_id, user_id)
     SELECT s.id, $1 FROM feed_status s WHERE s.id = $2 AND s.user_id <> $1 AND s.expires_at > now() AND ${notBlocked("s.user_id", 1)}
        AND EXISTS (SELECT 1 FROM feed_profiles WHERE user_id = $1)
     ON CONFLICT DO NOTHING`,
    [me, id],
  );
}

/** Quem viu: só para quem postou. */
export async function statusViewers(me: string, id: string) {
  if (!(await one("SELECT 1 FROM feed_status WHERE id = $1 AND user_id = $2", [id, me]))) return null;
  const rows = await many<{ user_id: string }>("SELECT user_id FROM feed_status_views WHERE status_id = $1 AND user_id <> $2 ORDER BY created_at DESC LIMIT 300", [id, me]);
  return people(me, rows.map((r) => r.user_id));
}

export async function deleteStatus(me: string, id: string, isSuper: boolean) {
  const r = await query("DELETE FROM feed_status WHERE id = $1 AND (user_id = $2 OR $3)", [id, me, isSuper]);
  return (r.rowCount ?? 0) > 0;
}

/** Limpeza de hora em hora: status vencido sai com a foto e a lista de quem viu. */
export async function purgeExpiredStatus() {
  return (await query("DELETE FROM feed_status WHERE expires_at < now()")).rowCount ?? 0;
}

// ---------- Fotos ----------

/** Foto de post ou de status que a pessoa pode ver (status só enquanto está no ar; nada de quem bloqueou). */
export async function readMedia(me: string, id: string) {
  const m = await one<{ mimetype: string; data: Buffer | null; storage_key: string | null }>(
    `SELECT m.mimetype, m.data, m.storage_key FROM feed_media m
       LEFT JOIN feed_posts p ON p.id = m.post_id
       LEFT JOIN feed_status s ON s.id = m.status_id
      WHERE m.id = $2 AND COALESCE(p.user_id, s.user_id) IS NOT NULL
        AND (m.status_id IS NULL OR s.expires_at > now())
        AND ${notBlocked("COALESCE(p.user_id, s.user_id)", 1)}`,
    [me, id],
  );
  if (!m) return null;
  return { mimetype: m.mimetype, data: await readBlob(m) };
}

// ---------- Denúncia ----------

const REPORT_TABLE = { post: "feed_posts", comment: "feed_comments", status: "feed_status", profile: "feed_profiles" } as const;

/** Denúncia vai para o sininho do dono, com o link para ele olhar e apagar. Uma por pessoa e por item. */
export async function report(me: string, input: { kind?: unknown; id?: unknown; reason?: unknown }) {
  const kind = String(input.kind ?? "") as keyof typeof REPORT_TABLE;
  const id = String(input.id ?? "");
  if (!REPORT_TABLE[kind] || !/^[0-9a-f-]{36}$/i.test(id)) throw new FeedError("Denúncia inválida.");
  const target = await one<{ user_id: string; post_id?: string }>(
    `SELECT user_id${kind === "comment" ? ", post_id" : ""} FROM ${REPORT_TABLE[kind]} WHERE ${kind === "profile" ? "user_id" : "id"} = $1`,
    [id],
  );
  if (!target) throw new FeedError("Não encontrado.", 404);
  if (target.user_id === me) throw new FeedError("Esse item é seu: você pode apagar.");
  await limit(me, "report", 30, "Muitas denúncias hoje. Tente de novo amanhã.");
  const reason = oneLine(input.reason, 200);
  const r = await query("INSERT INTO feed_reports (reporter_id, kind, target_id, reason) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [me, kind, id, reason]);
  if ((r.rowCount ?? 0) > 0) {
    const who = await authors([target.user_id, me]);
    const handle = who.get(target.user_id)?.handle ?? "";
    const label = { post: "uma publicação", comment: "um comentário", status: "um status", profile: "o perfil" }[kind];
    const link = kind === "post" ? `/rede/p/${id}` : kind === "comment" ? `/rede/p/${target.post_id}` : `/rede/u/${handle}`;
    await notify({
      userId: null,
      kind: "rede",
      title: `Denúncia na rede: ${label} de @${handle}`,
      body: `Por @${who.get(me)?.handle ?? "alguém"}${reason ? `: ${reason}` : "."}`,
      link,
    });
  }
  return { ok: true };
}
