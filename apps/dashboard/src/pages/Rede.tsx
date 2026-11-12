import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import type { Me } from "../App";
import { alertDialog, confirmDialog, Modal } from "../components";
import { useApi, useMedia } from "../hooks";
import { Icon } from "../icons";
import { UserMascote } from "../mascote/UserMascote";
import { haptic } from "../touch";
import "../styles/rede.css";
import {
  Avatar,
  BIO_MAX,
  COMMENT_MAX,
  count,
  FollowButton,
  MAX_PHOTOS,
  mediaUrl,
  NameOf,
  PeopleList,
  PersonRow,
  pickPhoto,
  POST_MAX,
  profilePath,
  RedeMe,
  RichText,
  shortTime,
  useRede,
  Verified,
  type Comment,
  type Person,
  type PickedPhoto,
  type Photo,
  type Post,
  type Profile,
} from "./redeBase";
import { StatusRow } from "./RedeStatus";

/**
 * Rede social do Planejai: o Feed é o que abre no Início (celular e notebook). Mistura do Instagram com o Twitter:
 * status de 24h em cima, posts curtos com até 4 fotos, posts em cartão (frase sobre cor) e cartões de link do blog,
 * curtir (até com dois toques na foto), comentar, seguir, perfil em grade, busca e atividade.
 * Olhar é livre; para publicar, curtir, comentar e seguir a pessoa cria o perfil (o avatar é o Bolinho dela).
 * O perfil oficial @planejai posta sozinho (status do WhatsApp, blog e posts de partida, feed-oficial.ts no servidor).
 * Telas: "/" (feed), /rede/p/:id (post), /rede/u/:handle (perfil), /rede/atividade, /rede/buscar.
 */

const PHONE = "(max-width: 767px)";
const quiet = { "x-pj-quiet": "1" };
interface MeData {
  profile: Profile | null;
  canJoin?: boolean;
  suggestion?: { handle: string; name: string };
  unread?: number;
}

/** Moldura das telas da rede: monta a coluna do meio e, no notebook, a coluna da direita. Sem perfil, só olha. */
function Shell({ me, title, back, children }: { me: Me; title?: string; back?: boolean; children: ReactNode }) {
  const mine = useApi<MeData>("/api/feed/me", { poll: 60_000 });
  const nav = useNavigate();
  const phone = useMedia(PHONE);
  const [joining, setJoining] = useState(false);
  const profile = mine.data?.profile ?? null;
  const canJoin = Boolean(mine.data?.canJoin);
  const join = useCallback(() => {
    if (profile) return true;
    haptic(6);
    if (canJoin) setJoining(true);
    else void alertDialog("Rede só para olhar", me.impersonating ? "Na conta de outra pessoa a rede é só para olhar." : "Ligue o seu WhatsApp ao Planejai para publicar e participar.");
    return false;
  }, [profile, canJoin, me.impersonating]);
  const ctx = useMemo(
    () => ({ profile, isSuper: me.role === "superadmin" && !me.impersonating, unread: mine.data?.unread ?? 0, reload: () => void mine.reload(), join }),
    [profile, mine.data, me.role, me.impersonating, mine.reload, join],
  );
  if (!mine.data) return mine.error ? <div className="rd"><div className="rd-col"><p className="rd-none">{mine.error}</p></div></div> : null;
  return (
    <RedeMe value={ctx}>
      <div className="rd">
        <div className="rd-col">
          {title && !phone && (
            <header className="rd-head">
              {back && <button type="button" className="icon-btn" onClick={() => (((history.state as { idx?: number } | null)?.idx ?? 0) > 0 ? nav(-1) : nav("/"))} aria-label="Voltar"><Icon name="chevron-left" size={20} /></button>}
              <h1>{title}</h1>
            </header>
          )}
          {children}
        </div>
        <Aside />
      </div>
      {joining && (
        <Join
          suggestion={mine.data.suggestion}
          onClose={() => setJoining(false)}
          onDone={() => {
            setJoining(false);
            void mine.reload();
          }}
        />
      )}
    </RedeMe>
  );
}

/** Coluna da direita (só notebook largo): busca, meu perfil (ou criar), atividade e quem seguir. */
function Aside() {
  const { profile, unread, join } = useRede();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const people = useApi<Person[]>("/api/feed/people");
  return (
    <aside className="rd-aside">
      <form className="rd-search" role="search" onSubmit={(e) => { e.preventDefault(); nav(`/rede/buscar${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`); }}>
        <Icon name="search" size={17} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar pessoas" aria-label="Buscar pessoas" />
      </form>
      {profile ? (
        <>
          <Link to={profilePath(profile.handle)} className="rd-mecard">
            <Avatar who={profile} size={48} me link={false} />
            <span>
              <strong>{profile.name}</strong>
              <em>@{profile.handle}</em>
            </span>
          </Link>
          <Link to="/rede/atividade" className="rd-aside-link">
            <Icon name="heart" size={18} /> Atividade
            {unread > 0 && <b>{unread > 99 ? "99+" : unread}</b>}
          </Link>
        </>
      ) : (
        <JoinCard onJoin={join} />
      )}
      {(people.data?.length ?? 0) > 0 && (
        <section className="rd-aside-box">
          <h2>Quem seguir</h2>
          {people.data!.slice(0, 4).map((p) => (
            <PersonRow key={p.id} p={{ ...p, bio: "" }} />
          ))}
          <Link to="/rede/buscar" className="rd-more">Ver mais</Link>
        </section>
      )}
      <p className="rd-aside-foot">Sua agenda, seus gastos e seu número nunca aparecem aqui.</p>
    </aside>
  );
}

/** Convite para quem está só olhando. */
function JoinCard({ onJoin, inline }: { onJoin: () => boolean; inline?: boolean }) {
  return (
    <div className={`rd-joincard${inline ? " inline" : ""}`}>
      <UserMascote size={inline ? 44 : 52} me />
      <div>
        <strong>Entre no Feed</strong>
        <p>Crie seu perfil para publicar, curtir e comentar.</p>
      </div>
      <button type="button" className="btn btn-brand" onClick={() => onJoin()}>Criar perfil</button>
    </div>
  );
}

/** Criar o perfil (o @ e o nome que os outros vão ver) ou editar. Nada da pessoa aparece antes disso. */
function Join({ suggestion, onDone, editing, onClose }: { suggestion?: { handle: string; name: string; bio?: string }; onDone: (handle: string) => void; editing?: boolean; onClose: () => void }) {
  const [handle, setHandle] = useState(suggestion?.handle ?? "");
  const [name, setName] = useState(suggestion?.name ?? "");
  const [bio, setBio] = useState(suggestion?.bio ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ profile: Profile }>("/api/feed/me", { method: "PUT", json: { handle, name, bio } });
      haptic(12);
      onDone(r.profile.handle);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={editing ? "Editar perfil" : "Criar seu perfil"}
      onClose={onClose}
      className="rd-join-modal"
      footer={(close) => (
        <>
          <button type="button" className="btn" onClick={close}>Cancelar</button>
          <button type="button" className="btn btn-brand" disabled={busy} onClick={() => void save()}>{busy ? "Salvando…" : editing ? "Salvar" : "Criar perfil"}</button>
        </>
      )}
    >
      <form className="rd-join-form" onSubmit={save}>
        {!editing && (
          <div className="rd-join-top">
            <UserMascote size={64} me />
            <p>Posts curtos, fotos e status que somem em 24 horas, com quem também usa o Planejai.</p>
          </div>
        )}
        <label className="rd-field">
          <span>Nome</span>
          <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Como você quer aparecer" autoComplete="off" required />
        </label>
        <label className="rd-field">
          <span>Seu @</span>
          <div className="rd-at">
            <b>@</b>
            <input value={handle} maxLength={20} onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, ""))} placeholder="seunome" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" required />
          </div>
        </label>
        <label className="rd-field">
          <span>Bio <i>opcional</i></span>
          <textarea value={bio} maxLength={BIO_MAX} rows={2} onChange={(e) => setBio(e.target.value)} placeholder="Uma linha sobre você" />
        </label>
        {error && <div className="error-box">{error}</div>}
        {!editing && (
          <ul className="rd-join-notes">
            <li><Icon name="shield" size={15} /> Sua agenda, seus gastos e seu número continuam só seus. Aqui aparece apenas o que você publicar.</li>
            <li><Icon name="user" size={15} /> Sua foto é o seu Bolinho. Você pode sair da rede quando quiser.</li>
          </ul>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ---------- Lista de posts com "carregar mais" ----------

interface Page {
  posts: Post[];
  next: string | null;
}
function usePosts(path: string | null, pick: (d: any) => Page = (d) => d) {
  // de minuto em minuto busca a primeira página de novo: post de outra pessoa aparece sem precisar puxar a tela
  const first = useApi<any>(path, { poll: 60_000 });
  const [extra, setExtra] = useState<{ path: string | null; posts: Post[]; next: string | null | undefined }>({ path, posts: [], next: undefined });
  const [loadingMore, setLoadingMore] = useState(false);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, Partial<Post>>>({});
  const [added, setAdded] = useState<Post[]>([]);
  if (extra.path !== path) {
    setExtra({ path, posts: [], next: undefined });
    setAdded([]);
  }
  const base = first.data ? pick(first.data) : null;
  const next = extra.path === path && extra.next !== undefined ? extra.next : (base?.next ?? null);
  const posts = useMemo(() => {
    const seen = new Set<string>();
    return [...added, ...(base?.posts ?? []), ...(extra.path === path ? extra.posts : [])]
      .filter((p) => !removed.has(p.id) && !seen.has(p.id) && seen.add(p.id))
      .map((p) => (edits[p.id] ? { ...p, ...edits[p.id] } : p));
  }, [added, base, extra, removed, edits, path]);
  const more = useCallback(async () => {
    if (!path || !next || loadingMore) return;
    setLoadingMore(true);
    try {
      const d = pick(await api(`${path}${path.includes("?") ? "&" : "?"}before=${encodeURIComponent(next)}`));
      setExtra((e) => (e.path === path ? { path, posts: [...e.posts, ...d.posts], next: d.next } : e));
    } catch {
      /* tenta de novo quando a pessoa rolar */
    } finally {
      setLoadingMore(false);
    }
  }, [path, next, loadingMore, pick]);
  return {
    posts,
    data: first.data,
    loading: first.loading,
    error: first.error,
    hasMore: Boolean(next),
    more,
    loadingMore,
    reload: first.reload,
    patch: (id: string, change: Partial<Post>) => setEdits((e) => ({ ...e, [id]: { ...e[id], ...change } })),
    remove: (id: string) => setRemoved((r) => new Set(r).add(id)),
    add: (p: Post) => setAdded((a) => [p, ...a]),
  };
}

/** Chama `more` quando o fim da lista chega perto da tela. */
function LoadMore({ on, more, busy }: { on: boolean; more: () => void; busy: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const fn = useRef(more);
  fn.current = more;
  useEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && fn.current(), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [on]);
  return on ? <div ref={ref} className="rd-wait" aria-busy={busy} /> : null;
}

// ---------- Post ----------

/** Dois toques curtem (como no Instagram); um toque abre. Devolve o handler de clique e o coração que pula. */
function useDoubleTap(onSingle: () => void, onDouble: () => void) {
  const last = useRef(0);
  const timer = useRef<number>(0);
  const [burst, setBurst] = useState(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const now = Date.now();
    if (now - last.current < 300) {
      window.clearTimeout(timer.current);
      last.current = 0;
      setBurst((b) => b + 1);
      onDouble();
      return;
    }
    last.current = now;
    timer.current = window.setTimeout(onSingle, 260);
  };
  return { onClick, burst };
}

const Burst = ({ n }: { n: number }) =>
  n ? (
    <span className="rd-burst" key={n} aria-hidden>
      <Heart on size={84} />
    </span>
  ) : null;

function Photos({ media, onOpen, onLike }: { media: Photo[]; onOpen: (i: number) => void; onLike: () => void }) {
  const [at, setAt] = useState(0);
  const strip = useRef<HTMLDivElement>(null);
  const tap = useDoubleTap(() => onOpen(at), onLike);
  if (!media.length) return null;
  const one = media[0]!;
  // proporção da primeira foto (entre 4:5 e 1,91:1, como no Instagram); as outras seguem a mesma moldura
  const ratio = one.w && one.h ? Math.min(1.91, Math.max(0.8, one.w / one.h)) : 1;
  const onScroll = () => {
    const el = strip.current;
    if (el) setAt(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
  };
  return (
    <div className="rd-media" style={{ aspectRatio: String(ratio) }} onClick={tap.onClick} role="button" tabIndex={-1} aria-label="Abrir foto">
      <div className="rd-strip" ref={strip} onScroll={onScroll}>
        {media.map((m) => (
          <img key={m.id} src={mediaUrl(m.id)} alt="" loading="lazy" decoding="async" draggable={false} />
        ))}
      </div>
      {media.length > 1 && (
        <>
          <span className="rd-count">{at + 1}/{media.length}</span>
          <span className="rd-dotsbar" aria-hidden>
            {media.map((m, i) => <i key={m.id} className={i === at ? "on" : ""} />)}
          </span>
        </>
      )}
      <Burst n={tap.burst} />
    </div>
  );
}

/** Post em cartão: a frase grande sobre uma cor lisa. */
function CardTile({ post, onLike, onOpen }: { post: Post; onLike: () => void; onOpen: () => void }) {
  const tap = useDoubleTap(onOpen, onLike);
  const long = post.body.length > 90;
  return (
    <div className={`rd-cardpost rd-card-${post.card}`} onClick={tap.onClick}>
      <p className={long ? "long" : ""}>{post.body}</p>
      <span className="rd-cardpost-by">@{post.author.handle}</span>
      <Burst n={tap.burst} />
    </div>
  );
}

/** Cartão de link (post do blog): capa, endereço, título e linha de apoio. Abre em outra aba. */
function LinkCard({ post }: { post: Post }) {
  const link = post.link!;
  let host = "";
  try {
    host = new URL(link.url).host.replace(/^www\./, "");
  } catch {
    /* endereço estranho */
  }
  const cover = post.media[0];
  return (
    <a className="rd-linkcard" href={link.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
      {cover && <img src={mediaUrl(cover.id)} alt="" loading="lazy" decoding="async" />}
      <span>
        {host && <em>{host}</em>}
        <strong>{link.title}</strong>
        {link.desc && <small>{link.desc}</small>}
      </span>
    </a>
  );
}

/**
 * Foto aberta em tela cheia: fundo preto de verdade (nada do feed aparece por trás), arrastar para os lados troca
 * de foto, puxar para baixo fecha. Abre e fecha com um zoom curto.
 */
function Lightbox({ media, start, onClose }: { media: Photo[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  const box = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; dy: number; down: boolean } | null>(null);
  const leaving = useRef(false);
  const calm = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const close = useCallback(() => {
    const b = box.current;
    if (leaving.current) return;
    leaving.current = true;
    if (!b || calm()) return onClose();
    const img = b.querySelectorAll<HTMLElement>(".rd-light-strip img")[i];
    img?.animate([{ transform: img.style.transform || "none", opacity: 1 }, { transform: "scale(.88)", opacity: 0 }], { duration: 200, easing: "ease-in", fill: "forwards" });
    b.animate([{ backgroundColor: getComputedStyle(b).backgroundColor }, { backgroundColor: "rgba(0, 0, 0, 0)" }], { duration: 220, easing: "ease-in", fill: "forwards" }).onfinish = onClose;
  }, [i, onClose]);

  useLayoutEffect(() => {
    const el = strip.current;
    if (el) el.scrollLeft = start * el.clientWidth;
    const b = box.current;
    if (!b || calm()) return;
    b.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
    b.querySelectorAll<HTMLElement>(".rd-light-strip img")[start]?.animate([{ transform: "scale(.9)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 300, easing: "cubic-bezier(.2, .9, .25, 1)" });
  }, [start]);

  useEffect(() => {
    const to = (n: number) => strip.current?.scrollTo({ left: n * strip.current.clientWidth, behavior: "smooth" });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") to(Math.min(media.length - 1, i + 1));
      if (e.key === "ArrowLeft") to(Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    // a página de trás não rola enquanto a foto está aberta
    const html = document.documentElement;
    const was = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      html.style.overflow = was;
    };
  }, [media.length, i, close]);

  const go = (n: number) => strip.current?.scrollTo({ left: n * strip.current.clientWidth, behavior: "smooth" });
  const img = () => box.current?.querySelectorAll<HTMLElement>(".rd-light-strip img")[i];
  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") return;
    drag.current = { x: e.clientX, y: e.clientY, dy: 0, down: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.down && dy > 12 && dy > Math.abs(dx) * 1.4) d.down = true;
    if (!d.down) return;
    d.dy = Math.max(0, dy);
    const el = img();
    if (el) el.style.transform = `translateY(${d.dy}px) scale(${1 - Math.min(d.dy, 400) / 1400})`;
    if (box.current) box.current.style.backgroundColor = `rgba(0, 0, 0, ${1 - Math.min(d.dy, 400) / 550})`;
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.down) return;
    if (d.dy > 110) return close();
    const el = img();
    if (el) {
      const from = el.style.transform;
      el.style.transform = "";
      el.animate([{ transform: from }, { transform: "none" }], { duration: 260, easing: "cubic-bezier(.2, .9, .25, 1)" });
    }
    if (box.current) box.current.style.backgroundColor = "";
  };

  return createPortal(
    <div className="rd-light" role="dialog" aria-modal="true" aria-label="Foto" ref={box} onClick={close} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <div
        className="rd-light-strip"
        ref={strip}
        onScroll={(e) => setI(Math.round(e.currentTarget.scrollLeft / Math.max(1, e.currentTarget.clientWidth)))}
      >
        {media.map((m) => (
          <div key={m.id} className="rd-light-slide">
            <img src={mediaUrl(m.id)} alt="" draggable={false} onClick={(e) => e.stopPropagation()} />
          </div>
        ))}
      </div>
      <button type="button" className="rd-light-x" onClick={(e) => { e.stopPropagation(); close(); }} aria-label="Fechar"><Icon name="x" size={20} /></button>
      {media.length > 1 && (
        <>
          <button type="button" className="rd-light-nav prev" disabled={i === 0} onClick={(e) => { e.stopPropagation(); go(i - 1); }} aria-label="Foto anterior"><Icon name="chevron-left" size={22} /></button>
          <button type="button" className="rd-light-nav next" disabled={i === media.length - 1} onClick={(e) => { e.stopPropagation(); go(i + 1); }} aria-label="Próxima foto"><Icon name="chevron-right" size={22} /></button>
          <span className="rd-light-n">{i + 1} / {media.length}</span>
        </>
      )}
    </div>,
    document.body,
  );
}

const Heart = ({ on, size = 22 }: { on: boolean; size?: number }) => (
  <svg className={`rd-heart${on ? " on" : ""}`} width={size} height={size} viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10" />
  </svg>
);

/** "Curtido por @ana e outras 3 pessoas" / "12 curtidas". */
function LikesLine({ post, onShow }: { post: Post; onShow: (e: React.MouseEvent) => void }) {
  if (!post.likes) return null;
  // o @ que vem do servidor nunca é o meu; se eu curti, eu estou entre os "outros"
  const others = post.likes - 1;
  return (
    <button type="button" className="rd-likes" onClick={onShow}>
      {post.liker ? (
        <>
          Curtido por <b>{post.liker}</b>
          {others > 0 && (
            <>
              {" "}e <b>{others === 1 ? (post.liked ? "você" : "outra pessoa") : `outras ${count(others)} pessoas`}</b>
            </>
          )}
        </>
      ) : (
        <b>{post.likes === 1 ? (post.liked ? "Você curtiu" : "1 curtida") : `${count(post.likes)} curtidas`}</b>
      )}
    </button>
  );
}

function PostCard({ post, detail, onPatch, onRemove }: { post: Post; detail?: boolean; onPatch: (c: Partial<Post>) => void; onRemove: () => void }) {
  const { isSuper, join } = useRede();
  const nav = useNavigate();
  const [menu, setMenu] = useState(false);
  const [likes, setLikes] = useState<Person[] | null | undefined>(undefined);
  const [photo, setPhoto] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const open = () => !detail && nav(`/rede/p/${post.id}`);
  const hasPhotos = post.media.length > 0 && !post.link;

  const setLiked = async (on: boolean) => {
    if (!join()) return;
    if (on === post.liked) return;
    haptic(on ? 12 : 6);
    onPatch({ liked: on, likes: Math.max(0, post.likes + (on ? 1 : -1)) });
    try {
      const r = await api<{ liked: boolean; likes: number }>(`/api/feed/posts/${post.id}/like`, { method: on ? "POST" : "DELETE", headers: quiet });
      onPatch(r);
    } catch {
      onPatch({ liked: post.liked, likes: post.likes });
    }
  };
  const like = (e: React.MouseEvent) => {
    e.stopPropagation();
    void setLiked(!post.liked);
  };
  const share = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const url = `${location.origin}/rede/p/${post.id}`;
    haptic(6);
    try {
      if (navigator.share) await navigator.share({ url, text: `${post.author.name} no Planejai` });
      else {
        await navigator.clipboard.writeText(url);
        void alertDialog("Link copiado", "Só quem está no Planejai consegue abrir.");
      }
    } catch {
      /* a pessoa fechou a folha de compartilhar */
    }
  };
  const showLikes = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setLikes(null);
    try {
      setLikes(await api<Person[]>(`/api/feed/posts/${post.id}/likes`));
    } catch {
      setLikes([]);
    }
  };
  const remove = async () => {
    setMenu(false);
    if (!(await confirmDialog({ title: "Apagar esta publicação?", body: post.mine ? "Ela some do feed com as curtidas e os comentários." : "Você está apagando a publicação de outra pessoa (moderação).", confirmLabel: "Apagar", danger: true }))) return;
    try {
      await api(`/api/feed/posts/${post.id}`, { method: "DELETE" });
      onRemove();
    } catch (err) {
      void alertDialog("Não deu para apagar", (err as Error).message);
    }
  };
  const report = async () => {
    setMenu(false);
    if (!join()) return;
    if (!(await confirmDialog({ title: "Denunciar esta publicação?", body: "O Planejai vai olhar e tirar do ar se não devia estar aqui. A pessoa não fica sabendo quem denunciou.", confirmLabel: "Denunciar", danger: true }))) return;
    try {
      await api("/api/feed/report", { method: "POST", json: { kind: "post", id: post.id } });
      void alertDialog("Denúncia enviada", "Obrigado por avisar.");
    } catch (err) {
      void alertDialog("Não deu para denunciar", (err as Error).message);
    }
  };
  const block = async () => {
    setMenu(false);
    if (!join()) return;
    if (!(await confirmDialog({ title: `Bloquear @${post.author.handle}?`, body: "Vocês deixam de se seguir e um não vê mais nada do outro.", confirmLabel: "Bloquear", danger: true }))) return;
    await api(`/api/feed/u/${post.author.handle}/block`, { method: "POST" }).catch(() => {});
    onRemove();
  };

  // legenda longa fica recolhida no feed ("mais"), como no Instagram
  const longBody = !detail && !expanded && post.body.length > 220;
  const body = post.body && !post.card && (
    <p className={`rd-body${hasPhotos ? " caption" : ""}`}>
      {hasPhotos && (
        <Link to={profilePath(post.author.handle)} className="rd-cap-name" onClick={(e) => e.stopPropagation()}>{post.author.handle}</Link>
      )}
      <RichText text={longBody ? `${post.body.slice(0, 200).trimEnd()}…` : post.body} />
      {longBody && (
        <button type="button" className="rd-more-btn" onClick={(e) => { e.stopPropagation(); setExpanded(true); }}>mais</button>
      )}
    </p>
  );

  return (
    <>
    <article className={`rd-post${detail ? " detail" : ""}${hasPhotos ? " has-media" : ""}`} onClick={open} tabIndex={detail ? undefined : 0} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && open()}>
      <header className="rd-post-head">
        <Avatar who={post.author} size={detail ? 44 : 38} me={post.mine} />
        <Link to={profilePath(post.author.handle)} className="rd-who" onClick={(e) => e.stopPropagation()}>
          <strong><NameOf who={post.author} /></strong>
          <span>@{post.author.handle} · <time dateTime={post.created_at}>{shortTime(post.created_at)}</time></span>
        </Link>
        <button type="button" className="rd-dots" onClick={(e) => { e.stopPropagation(); haptic(5); setMenu(true); }} aria-label="Mais opções"><Icon name="more" size={18} /></button>
      </header>
      {!hasPhotos && body}
      {post.card && <CardTile post={post} onLike={() => void setLiked(true)} onOpen={open} />}
      {post.link && <LinkCard post={post} />}
      {hasPhotos && <Photos media={post.media} onOpen={setPhoto} onLike={() => void setLiked(true)} />}
      <footer className="rd-acts">
        <button type="button" className={`rd-act${post.liked ? " liked" : ""}`} onClick={like} aria-pressed={post.liked} aria-label={post.liked ? "Tirar curtida" : "Curtir"}>
          <Heart on={post.liked} key={post.liked ? "on" : "off"} />
        </button>
        <button type="button" className="rd-act" onClick={(e) => { e.stopPropagation(); if (detail) document.getElementById("rd-reply")?.focus(); else open(); }} aria-label="Comentar">
          <Icon name="message" size={21} />
        </button>
        <button type="button" className="rd-act" onClick={share} aria-label="Compartilhar"><Icon name="send" size={20} /></button>
      </footer>
      <div className="rd-post-foot">
        <LikesLine post={post} onShow={showLikes} />
        {hasPhotos && body}
        {!detail && post.comments > 0 && (
          <button type="button" className="rd-seecom" onClick={(e) => { e.stopPropagation(); open(); }}>
            {post.comments === 1 ? "Ver 1 comentário" : `Ver os ${count(post.comments)} comentários`}
          </button>
        )}
        {detail && <time className="rd-fulltime" dateTime={post.created_at}>{fullTime(post.created_at)}</time>}
      </div>
    </article>
      {menu && (
        <Modal title="Publicação" onClose={() => setMenu(false)} bare>
          <div>
            {(post.mine || isSuper) && (
              <button type="button" className="sheet-item rd-danger" onClick={remove}><span className="ico-box"><Icon name="trash" size={17} /></span>Apagar{post.mine ? "" : " (moderação)"}</button>
            )}
            {!post.mine && !post.author.official && (
              <>
                <button type="button" className="sheet-item" onClick={report}><span className="ico-box"><Icon name="shield" size={17} /></span>Denunciar</button>
                <button type="button" className="sheet-item" onClick={block}><span className="ico-box"><Icon name="eye-off" size={17} /></span>Bloquear @{post.author.handle}</button>
              </>
            )}
            <button type="button" className="sheet-item" onClick={(e) => { setMenu(false); void share(e); }}><span className="ico-box"><Icon name="link" size={17} /></span>Compartilhar</button>
          </div>
        </Modal>
      )}
      {likes !== undefined && (
        <Modal title="Curtidas" onClose={() => setLikes(undefined)}>
          <div>
            <PeopleList people={likes} empty="Ninguém curtiu ainda." onNavigate={() => setLikes(undefined)} />
          </div>
        </Modal>
      )}
      {photo != null && <Lightbox media={post.media} start={photo} onClose={() => setPhoto(null)} />}
    </>
  );
}

const FULL = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "long", year: "numeric" });
const fullTime = (iso: string) => FULL.format(new Date(iso)).replace(" às ", " · ");

function PostList({ list, empty }: { list: ReturnType<typeof usePosts>; empty: ReactNode }) {
  if (list.loading && !list.posts.length) return <PostSkeleton />;
  if (list.error && !list.posts.length) return <p className="rd-none">{list.error}</p>;
  if (!list.posts.length) return <>{empty}</>;
  return (
    <>
      {list.posts.map((p) => (
        <PostCard key={p.id} post={p} onPatch={(c) => list.patch(p.id, c)} onRemove={() => list.remove(p.id)} />
      ))}
      <LoadMore on={list.hasMore} more={list.more} busy={list.loadingMore} />
      {!list.hasMore && list.posts.length > 4 && <p className="rd-end">Você viu tudo por enquanto.</p>}
    </>
  );
}

const PostSkeleton = () => (
  <div className="rd-skel" aria-busy="true" aria-label="Carregando">
    {[0, 1, 2].map((i) => (
      <div key={i}><i /><span><b /><b /><b /></span></div>
    ))}
  </div>
);

// ---------- Escrever ----------

function Composer({ onPosted, autoFocus, inline }: { onPosted: (p: Post) => void; autoFocus?: boolean; inline?: boolean }) {
  // só aparece para quem já tem perfil
  const profile = useRede().profile!;
  const [body, setBody] = useState("");
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  // a caixa cresce com o texto
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(320, el.scrollHeight)}px`;
  }, [body]);

  const add = async (files: FileList | null) => {
    setError(null);
    const room = MAX_PHOTOS - photos.length;
    const picked: PickedPhoto[] = [];
    try {
      for (const f of Array.from(files ?? []).slice(0, room)) picked.push(await pickPhoto(f));
    } catch (err) {
      setError((err as Error).message);
    }
    if (picked.length) setPhotos((p) => [...p, ...picked].slice(0, MAX_PHOTOS));
  };
  const can = (body.trim().length > 0 || photos.length > 0) && !busy;
  const send = async () => {
    if (!can) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ post: Post }>("/api/feed/posts", { method: "POST", json: { body, photos: photos.map((p) => ({ base64: p.base64, width: p.width, height: p.height })) } });
      haptic(12);
      setBody("");
      setPhotos([]);
      onPosted(r.post);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const left = POST_MAX - body.length;

  return (
    <div className={`rd-compose${inline ? " inline" : ""}`}>
      <Avatar who={profile} size={42} me link={false} />
      <div className="rd-compose-main">
        <textarea
          ref={area}
          value={body}
          rows={inline ? 1 : 3}
          maxLength={POST_MAX}
          autoFocus={autoFocus}
          placeholder="O que está acontecendo?"
          aria-label="Escrever publicação"
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && void send()}
        />
        {photos.length > 0 && (
          <div className={`rd-compose-photos n${photos.length}`}>
            {photos.map((p, i) => (
              <span key={i}>
                <img src={p.preview} alt="" />
                <button type="button" onClick={() => setPhotos((list) => list.filter((_, j) => j !== i))} aria-label="Tirar foto"><Icon name="x" size={14} /></button>
              </span>
            ))}
          </div>
        )}
        {error && <div className="error-box">{error}</div>}
        <div className="rd-compose-bar">
          <button type="button" className="rd-tool" disabled={photos.length >= MAX_PHOTOS} onClick={() => file.current?.click()} aria-label="Adicionar foto" title={`Foto (até ${MAX_PHOTOS})`}><Icon name="image" size={20} /></button>
          <input ref={file} type="file" accept="image/*" multiple hidden onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
          <span className="spacer" />
          {left <= 80 && <span className={`rd-left${left <= 20 ? " low" : ""}`} aria-live="polite">{left}</span>}
          <button type="button" className="btn btn-brand rd-send" disabled={!can} onClick={send}>{busy ? "Publicando…" : "Publicar"}</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Feed (o Início) ----------

type Tab = "all" | "following";
const readTab = (): Tab => {
  try {
    return sessionStorage.getItem("pj-feed-tab") === "following" ? "following" : "all";
  } catch {
    return "all";
  }
};

function FeedHome() {
  const { unread, profile, join } = useRede();
  const phone = useMedia(PHONE);
  const [tab, setTabState] = useState<Tab>(readTab);
  const [writing, setWriting] = useState(false);
  const list = usePosts(`/api/feed?tab=${tab}`);
  const setTab = (t: Tab) => {
    haptic(5);
    setTabState(t);
    try {
      sessionStorage.setItem("pj-feed-tab", t);
    } catch {
      /* sem storage */
    }
  };
  return (
    <>
      <StatusRow />
      <div className="rd-bar">
        <div className="rd-tabs" role="tablist" style={{ ["--i" as string]: tab === "all" ? 0 : 1 }}>
          <button type="button" role="tab" aria-selected={tab === "all"} className={tab === "all" ? "on" : ""} onClick={() => setTab("all")}>Para você</button>
          <button type="button" role="tab" aria-selected={tab === "following"} className={tab === "following" ? "on" : ""} onClick={() => setTab("following")}>Seguindo</button>
        </div>
        <span className="spacer" />
        <div className="rd-bar-icons">
          <Link to="/rede/buscar" className="rd-ico" aria-label="Buscar pessoas"><Icon name="search" size={22} /></Link>
          {profile && (
            <Link to="/rede/atividade" className="rd-ico rd-bell" aria-label={unread ? `Atividade, ${unread} novas` : "Atividade"}>
              <Icon name="heart" size={22} />
              {unread > 0 && <i />}
            </Link>
          )}
        </div>
      </div>
      {!profile && phone && <JoinCard inline onJoin={join} />}
      {profile && phone && (
        // no celular, escrever fica no topo do feed (sem botão flutuante tampando os posts)
        <button type="button" className="rd-prompt" onClick={() => { haptic(6); setWriting(true); }}>
          <Avatar who={profile} size={36} me link={false} />
          <span className="rd-prompt-txt">No que você está pensando?</span>
          <Icon name="image" size={20} />
        </button>
      )}
      {profile && !phone && <Composer inline onPosted={list.add} />}
      <PostList
        list={list}
        empty={
          tab === "following" ? (
            <Blank title="Ninguém por aqui ainda" text="Siga algumas pessoas e os posts delas aparecem nesta aba." action={<Link className="btn" to="/rede/buscar"><Icon name="search" size={16} /> Encontrar pessoas</Link>} />
          ) : (
            <Blank title="O feed está começando" text="Seja a primeira pessoa a publicar. Vale uma ideia, uma foto ou um status." action={<button type="button" className="btn btn-brand" onClick={() => join() && setWriting(true)}><Icon name="edit" size={16} /> Escrever</button>} />
          )
        }
      />
      {writing && (
        <Modal title="Nova publicação" onClose={() => setWriting(false)} className="rd-compose-modal">
          {(close) => <Composer autoFocus onPosted={(p) => { list.add(p); close(); }} />}
        </Modal>
      )}
    </>
  );
}

const Blank = ({ title, text, action }: { title: string; text: string; action?: ReactNode }) => (
  <div className="rd-blank">
    <UserMascote size={72} me />
    <h2>{title}</h2>
    <p>{text}</p>
    {action}
  </div>
);

// ---------- Post aberto ----------

function PostScreen() {
  const { id = "" } = useParams();
  const { profile, isSuper, join } = useRede();
  const nav = useNavigate();
  const data = useApi<{ post: Post; comments: Comment[] }>(`/api/feed/posts/${id}`);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (data.error && !data.data) return <Blank title="Publicação não encontrada" text="Ela pode ter sido apagada." action={<Link className="btn" to="/">Voltar ao feed</Link>} />;
  if (!data.data) return <PostSkeleton />;
  const { post, comments } = data.data;
  const patch = (c: Partial<Post>) => data.setData((d) => (d ? { ...d, post: { ...d.post, ...c } } : d));
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ comment: Comment }>(`/api/feed/posts/${id}/comments`, { method: "POST", json: { body: text } });
      haptic(10);
      setText("");
      data.setData((d) => (d ? { post: { ...d.post, comments: d.post.comments + 1 }, comments: [...d.comments, r.comment] } : d));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const drop = async (c: Comment) => {
    if (!(await confirmDialog({ title: "Apagar este comentário?", confirmLabel: "Apagar", danger: true }))) return;
    await api(`/api/feed/comments/${c.id}`, { method: "DELETE" }).catch(() => {});
    data.setData((d) => (d ? { post: { ...d.post, comments: Math.max(0, d.post.comments - 1) }, comments: d.comments.filter((x) => x.id !== c.id) } : d));
  };
  const reportIt = async (c: Comment) => {
    if (!(await confirmDialog({ title: "Denunciar este comentário?", body: "O Planejai vai olhar e tirar do ar se não devia estar aqui.", confirmLabel: "Denunciar", danger: true }))) return;
    await api("/api/feed/report", { method: "POST", json: { kind: "comment", id: c.id } }).catch(() => {});
  };
  return (
    <>
      <PostCard post={post} detail onPatch={patch} onRemove={() => nav("/", { replace: true })} />
      {profile ? (
        <form className="rd-reply" onSubmit={send}>
          <Avatar who={profile} size={34} me link={false} />
          <input id="rd-reply" value={text} maxLength={COMMENT_MAX} onChange={(e) => setText(e.target.value)} placeholder={`Responder a ${post.author.official ? post.author.name : post.author.name.split(" ")[0]}`} aria-label="Escrever comentário" />
          <button type="submit" className="rd-reply-go" disabled={!text.trim() || busy} aria-label="Enviar comentário"><Icon name="arrow-up" size={18} /></button>
        </form>
      ) : (
        <button type="button" id="rd-reply" className="rd-reply rd-reply-join" onClick={() => join()}>
          <Icon name="message" size={18} /> Crie seu perfil para comentar
        </button>
      )}
      {error && <div className="error-box">{error}</div>}
      <div className="rd-comments">
        {comments.map((c) => (
          <div className="rd-comment" key={c.id}>
            <Avatar who={c.author} size={34} me={c.mine} />
            <div>
              <header>
                <Link to={profilePath(c.author.handle)}><strong><NameOf who={c.author} /></strong></Link>
                <time dateTime={c.created_at}>{shortTime(c.created_at)}</time>
              </header>
              <p><RichText text={c.body} /></p>
            </div>
            {!profile ? null : c.canDelete || isSuper ? (
              <button type="button" className="rd-dots" onClick={() => void drop(c)} aria-label="Apagar comentário"><Icon name="trash" size={15} /></button>
            ) : (
              <button type="button" className="rd-dots" onClick={() => void reportIt(c)} aria-label="Denunciar comentário"><Icon name="shield" size={15} /></button>
            )}
          </div>
        ))}
        {!comments.length && <p className="rd-none">Nenhum comentário ainda. Comece a conversa.</p>}
      </div>
    </>
  );
}

// ---------- Perfil ----------

/** Quadradinho da grade do perfil: foto, cartão de frase ou texto. */
function Tile({ post }: { post: Post }) {
  const cover = post.media[0];
  return (
    <Link to={`/rede/p/${post.id}`} className={`rd-tile${post.card ? ` rd-card-${post.card}` : cover ? "" : " text"}`} aria-label={post.body ? post.body.slice(0, 80) : "Abrir publicação"}>
      {cover ? <img src={mediaUrl(cover.id)} alt="" loading="lazy" decoding="async" /> : <p>{post.body}</p>}
      {(post.media.length > 1 || post.link) && (
        <span className="rd-tile-mark" aria-hidden><Icon name={post.link ? "link" : "copy"} size={15} /></span>
      )}
      {(post.likes > 0 || post.comments > 0) && (
        <span className="rd-tile-hover" aria-hidden>
          <span><Heart on size={17} /> {count(post.likes)}</span>
          <span><Icon name="message" size={17} /> {count(post.comments)}</span>
        </span>
      )}
    </Link>
  );
}

function ProfileScreen() {
  const { handle = "" } = useParams();
  const me = useRede();
  const nav = useNavigate();
  const phone = useMedia(PHONE);
  const pick = useCallback((d: any) => ({ posts: d.posts, next: d.next }), []);
  const list = usePosts(`/api/feed/u/${handle}`, pick);
  const [view, setView] = useState<"grade" | "lista">("grade");
  const [people, setPeople] = useState<{ title: string; list: Person[] | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [delta, setDelta] = useState(0);
  const p: Profile | undefined = list.data?.profile;
  if (list.error && !p) return <Blank title="Perfil não encontrado" text="Esse @ não existe ou não está disponível para você." action={<Link className="btn" to="/">Voltar ao feed</Link>} />;
  if (!p) return <PostSkeleton />;

  const openPeople = async (kind: "seguidores" | "seguindo") => {
    setPeople({ title: kind === "seguidores" ? "Seguidores" : "Seguindo", list: null });
    try {
      const r = await api<Person[]>(`/api/feed/u/${p.handle}/${kind}`);
      setPeople((cur) => cur && { ...cur, list: r });
    } catch {
      setPeople((cur) => cur && { ...cur, list: [] });
    }
  };
  const block = async () => {
    setMenu(false);
    if (!me.join()) return;
    if (!p.blocked && !(await confirmDialog({ title: `Bloquear @${p.handle}?`, body: "Vocês deixam de se seguir e um não vê mais nada do outro.", confirmLabel: "Bloquear", danger: true }))) return;
    await api(`/api/feed/u/${p.handle}/block`, { method: p.blocked ? "DELETE" : "POST" }).catch(() => {});
    void list.reload();
  };
  const report = async () => {
    setMenu(false);
    if (!me.join()) return;
    if (!(await confirmDialog({ title: `Denunciar @${p.handle}?`, body: "O Planejai vai olhar o perfil. A pessoa não fica sabendo quem denunciou.", confirmLabel: "Denunciar", danger: true }))) return;
    await api("/api/feed/report", { method: "POST", json: { kind: "profile", id: p.handle } }).catch(() => {});
  };
  const leave = async () => {
    setMenu(false);
    if (!(await confirmDialog({ title: "Sair da rede?", body: "Seu perfil, suas publicações, status, curtidas e comentários são apagados de vez. O resto do Planejai continua igual.", confirmLabel: "Sair e apagar tudo", danger: true }))) return;
    await api("/api/feed/me", { method: "DELETE" });
    me.reload();
    nav("/", { replace: true });
  };
  const stats = (
    <div className="rd-stats">
      <span><b>{count(p.posts)}</b> {p.posts === 1 ? "publicação" : "publicações"}</span>
      <button type="button" onClick={() => void openPeople("seguidores")}><b>{count(Math.max(0, p.followers + delta))}</b> seguidores</button>
      <button type="button" onClick={() => void openPeople("seguindo")}><b>{count(p.following)}</b> seguindo</button>
    </div>
  );
  const actions = (
    <div className="rd-profile-acts">
      {p.me ? (
        <button type="button" className="btn" onClick={() => setEditing(true)}>Editar perfil</button>
      ) : p.blocked ? (
        <button type="button" className="btn" onClick={block}>Desbloquear</button>
      ) : (
        <FollowButton key={String(p.iFollow)} handle={p.handle} following={p.iFollow} onChange={(on) => setDelta((d) => d + (on ? 1 : -1))} />
      )}
      <button type="button" className="btn rd-sq" onClick={() => setMenu(true)} aria-label="Mais opções"><Icon name="more" size={18} /></button>
    </div>
  );

  return (
    <>
      <section className="rd-profile">
        <Avatar who={p} size={phone ? 86 : 132} me={p.me} link={false} />
        <div className="rd-profile-info">
          <div className="rd-profile-line">
            <h1>{p.handle}{p.official && <Verified size={18} />}</h1>
            {!phone && actions}
          </div>
          {stats}
          <div className="rd-profile-bio">
            <strong>{p.name}</strong>
            {p.followsMe && !p.me && <i className="rd-followsme">Segue você</i>}
            {p.bio && <p><RichText text={p.bio} /></p>}
          </div>
        </div>
        {phone && actions}
      </section>
      {p.blocked ? (
        <p className="rd-none">Você bloqueou este perfil.</p>
      ) : (
        <>
          <div className="rd-ptabs" role="tablist">
            <button type="button" role="tab" aria-selected={view === "grade"} className={view === "grade" ? "on" : ""} onClick={() => { haptic(5); setView("grade"); }} aria-label="Grade"><Icon name="apps" size={20} /><span>Publicações</span></button>
            <button type="button" role="tab" aria-selected={view === "lista"} className={view === "lista" ? "on" : ""} onClick={() => { haptic(5); setView("lista"); }} aria-label="Lista"><Icon name="rows" size={20} /><span>Lista</span></button>
          </div>
          {view === "lista" ? (
            <PostList list={list} empty={<p className="rd-none">{p.me ? "Você ainda não publicou nada." : "Nenhuma publicação ainda."}</p>} />
          ) : list.posts.length ? (
            <>
              <div className="rd-grid">
                {list.posts.map((post) => <Tile key={post.id} post={post} />)}
              </div>
              <LoadMore on={list.hasMore} more={list.more} busy={list.loadingMore} />
            </>
          ) : list.loading ? (
            <PostSkeleton />
          ) : (
            <p className="rd-none">{p.me ? "Você ainda não publicou nada." : "Nenhuma publicação ainda."}</p>
          )}
        </>
      )}
      {people && (
        <Modal title={people.title} onClose={() => setPeople(null)}>
          <PeopleList people={people.list} empty={people.title === "Seguidores" ? "Ninguém segue ainda." : "Não segue ninguém ainda."} onNavigate={() => setPeople(null)} />
        </Modal>
      )}
      {editing && <Join editing suggestion={{ handle: p.handle, name: p.name, bio: p.bio }} onClose={() => setEditing(false)} onDone={(h) => { setEditing(false); me.reload(); if (h !== p.handle) nav(profilePath(h), { replace: true }); else void list.reload(); }} />}
      {menu && (
        <Modal title={`@${p.handle}`} onClose={() => setMenu(false)} bare>
          {p.me ? (
            <button type="button" className="sheet-item rd-danger" onClick={leave}><span className="ico-box"><Icon name="logout" size={17} /></span>Sair da rede e apagar tudo</button>
          ) : p.official ? null : (
            <>
              <button type="button" className="sheet-item" onClick={block}><span className="ico-box"><Icon name="eye-off" size={17} /></span>{p.blocked ? "Desbloquear" : "Bloquear"}</button>
              <button type="button" className="sheet-item" onClick={report}><span className="ico-box"><Icon name="shield" size={17} /></span>Denunciar perfil</button>
            </>
          )}
          <button type="button" className="sheet-item" onClick={() => { setMenu(false); void navigator.clipboard?.writeText(`${location.origin}${profilePath(p.handle)}`); }}><span className="ico-box"><Icon name="link" size={17} /></span>Copiar link do perfil</button>
        </Modal>
      )}
    </>
  );
}

// ---------- Atividade ----------

interface ActivityItem {
  kind: "like" | "comment" | "follow";
  actor: Person;
  post_id: string | null;
  post: string | null;
  text: string | null;
  created_at: string;
  unread: boolean;
}

function ActivityScreen() {
  const me = useRede();
  const list = useApi<ActivityItem[]>(me.profile ? "/api/feed/activity" : null);
  // abrir a tela marca como visto: a bolinha do coração some
  useEffect(() => {
    if (list.data) me.reload();
  }, [list.data, me.reload]);
  if (!me.profile) return <Blank title="Sem atividade" text="Crie seu perfil para ver quem curtiu, comentou e começou a seguir você." action={<button type="button" className="btn btn-brand" onClick={() => me.join()}>Criar perfil</button>} />;
  if (!list.data) return <PostSkeleton />;
  if (!list.data.length) return <Blank title="Nada por aqui ainda" text="Curtidas, comentários e novos seguidores aparecem aqui." />;
  const say = (a: ActivityItem) => (a.kind === "like" ? "curtiu sua publicação" : a.kind === "comment" ? "comentou" : "começou a seguir você");
  return (
    <div className="rd-activity">
      {list.data.map((a, i) => (
        <div className={`rd-act-row${a.unread ? " new" : ""}`} key={i}>
          <span className={`rd-act-ico ${a.kind}`}>
            {a.kind === "like" ? <Heart on size={14} /> : <Icon name={a.kind === "comment" ? "message" : "user-plus"} size={14} />}
          </span>
          <Avatar who={a.actor} size={40} />
          <Link to={a.post_id ? `/rede/p/${a.post_id}` : profilePath(a.actor.handle)} className="rd-act-txt">
            <span><strong>{a.actor.name}</strong> {say(a)}{a.kind === "comment" && a.text ? `: ${a.text}` : ""}</span>
            {a.kind === "like" && a.post && <em>{a.post}</em>}
            <time dateTime={a.created_at}>{shortTime(a.created_at)}</time>
          </Link>
          {a.kind === "follow" && <FollowButton handle={a.actor.handle} following={a.actor.following} small />}
        </div>
      ))}
    </div>
  );
}

// ---------- Busca ----------

function SearchScreen() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [term, setTerm] = useState(q.trim());
  useEffect(() => {
    const t = setTimeout(() => {
      setTerm(q.trim());
      setParams(q.trim() ? { q: q.trim() } : {}, { replace: true });
    }, 280);
    return () => clearTimeout(t);
  }, [q, setParams]);
  const people = useApi<Person[]>(`/api/feed/people${term ? `?q=${encodeURIComponent(term)}` : ""}`);
  return (
    <>
      <div className="rd-search big">
        <Icon name="search" size={18} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome ou @" aria-label="Buscar pessoas" autoFocus={!matchMedia("(pointer: coarse)").matches} />
        {q && <button type="button" onClick={() => setQ("")} aria-label="Limpar"><Icon name="x" size={16} /></button>}
      </div>
      {!term && <h2 className="rd-sub">Sugestões</h2>}
      <PeopleList people={people.data} empty={term ? "Ninguém com esse nome ou @." : "Você já segue todo mundo que está na rede."} />
    </>
  );
}

// ---------- Rotas ----------

export function FeedPage({ me }: { me: Me }) {
  return <Shell me={me}><FeedHome /></Shell>;
}
export function RedePostPage({ me }: { me: Me }) {
  return <Shell me={me} title="Publicação" back><PostScreen /></Shell>;
}
export function RedeProfilePage({ me }: { me: Me }) {
  return <Shell me={me} title="Perfil" back><ProfileScreen /></Shell>;
}
export function RedeActivityPage({ me }: { me: Me }) {
  return <Shell me={me} title="Atividade" back><ActivityScreen /></Shell>;
}
export function RedeSearchPage({ me }: { me: Me }) {
  return <Shell me={me} title="Buscar" back><SearchScreen /></Shell>;
}
