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
  PeopleList,
  PersonRow,
  pickPhoto,
  POST_MAX,
  profilePath,
  RedeMe,
  RichText,
  shortTime,
  useRede,
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
 * status de 24h em cima, posts curtos com até 4 fotos, curtir, comentar, seguir, perfil, busca e atividade.
 * A pessoa só entra (e só aparece para os outros) depois de criar o perfil; o avatar é o Bolinho dela.
 * Telas: "/" (feed), /rede/p/:id (post), /rede/u/:handle (perfil), /rede/atividade, /rede/buscar.
 */

const PHONE = "(max-width: 767px)";
const quiet = { "x-pj-quiet": "1" };
interface MeData {
  profile: Profile | null;
  suggestion?: { handle: string; name: string };
  unread?: number;
}

/** Moldura das telas da rede: confere o perfil, monta a coluna do meio e, no notebook, a coluna da direita. */
function Shell({ me, title, back, children }: { me: Me; title?: string; back?: boolean; children: ReactNode }) {
  const mine = useApi<MeData>("/api/feed/me", { poll: 60_000 });
  const nav = useNavigate();
  const phone = useMedia(PHONE);
  const ctx = useMemo(
    () => (mine.data?.profile ? { profile: mine.data.profile, isSuper: me.role === "superadmin" && !me.impersonating, unread: mine.data.unread ?? 0, reload: () => void mine.reload() } : null),
    [mine.data, me.role, me.impersonating, mine.reload],
  );
  if (!mine.data) return mine.error ? <div className="rd"><div className="rd-col"><p className="rd-none">{mine.error}</p></div></div> : null;
  if (!ctx) return <Join suggestion={mine.data.suggestion} onDone={() => void mine.reload()} />;
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
    </RedeMe>
  );
}

/** Coluna da direita (só notebook largo): busca, meu perfil e quem seguir. */
function Aside() {
  const { profile, unread } = useRede();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const people = useApi<Person[]>("/api/feed/people");
  return (
    <aside className="rd-aside">
      <form className="rd-search" role="search" onSubmit={(e) => { e.preventDefault(); nav(`/rede/buscar${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`); }}>
        <Icon name="search" size={17} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar pessoas" aria-label="Buscar pessoas" />
      </form>
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
      {(people.data?.length ?? 0) > 0 && (
        <section className="rd-aside-box">
          <h2>Quem seguir</h2>
          {people.data!.slice(0, 4).map((p) => (
            <PersonRow key={p.id} p={{ ...p, bio: "" }} />
          ))}
          <Link to="/rede/buscar" className="rd-more">Ver mais</Link>
        </section>
      )}
    </aside>
  );
}

/** Primeira vez: a pessoa escolhe o @ e o nome que os outros vão ver. Nada dela aparece antes disso. */
function Join({ suggestion, onDone, editing, onClose }: { suggestion?: { handle: string; name: string; bio?: string }; onDone: (handle: string) => void; editing?: boolean; onClose?: () => void }) {
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
  const fields = (
    <>
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
    </>
  );
  if (editing)
    return (
      <Modal
        title="Editar perfil"
        onClose={onClose!}
        footer={(close) => (
          <>
            <button type="button" className="btn" onClick={close}>Cancelar</button>
            <button type="button" className="btn btn-brand" disabled={busy} onClick={() => void save()}>{busy ? "Salvando…" : "Salvar"}</button>
          </>
        )}
      >
        <form className="rd-join-form" onSubmit={save}>{fields}</form>
      </Modal>
    );
  return (
    <div className="rd rd-join">
      <form className="rd-join-card" onSubmit={save}>
        <UserMascote size={92} me />
        <h1>Entre no Feed do Planejai</h1>
        <p>Um lugar para trocar ideias com quem também usa o Planejai: posts curtos, fotos e status que somem em 24 horas.</p>
        {fields}
        <button type="submit" className="btn btn-brand rd-join-go" disabled={busy}>{busy ? "Criando…" : "Criar meu perfil"}</button>
        <ul className="rd-join-notes">
          <li><Icon name="shield" size={15} /> Sua agenda, seus gastos e seu número continuam só seus. Aqui aparece apenas o que você publicar.</li>
          <li><Icon name="user" size={15} /> Sua foto é o seu Bolinho. Você pode sair da rede quando quiser.</li>
        </ul>
      </form>
    </div>
  );
}

// ---------- Lista de posts com "carregar mais" ----------

interface Page {
  posts: Post[];
  next: string | null;
}
function usePosts(path: string | null, pick: (d: any) => Page = (d) => d) {
  const first = useApi<any>(path);
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

function Photos({ media, onOpen }: { media: Photo[]; onOpen: (i: number) => void }) {
  if (!media.length) return null;
  const one = media[0]!;
  // uma foto só respeita a proporção dela (entre 4:5 e 2:1); várias viram grade
  const ratio = one.w && one.h ? Math.min(2, Math.max(0.8, one.w / one.h)) : 1.25;
  return (
    <div className={`rd-photos n${Math.min(4, media.length)}`} style={media.length === 1 ? { aspectRatio: String(ratio) } : undefined}>
      {media.slice(0, 4).map((m, i) => (
        <button type="button" key={m.id} onClick={(e) => { e.stopPropagation(); onOpen(i); }} aria-label={`Abrir foto ${i + 1}`}>
          <img src={mediaUrl(m.id)} alt="" loading="lazy" decoding="async" />
        </button>
      ))}
    </div>
  );
}

function Lightbox({ media, start, onClose }: { media: Photo[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setI((v) => Math.min(media.length - 1, v + 1));
      if (e.key === "ArrowLeft") setI((v) => Math.max(0, v - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [media.length, onClose]);
  return createPortal(
    <div className="rd-light" role="dialog" aria-modal="true" aria-label="Foto" onClick={onClose}>
      <img src={mediaUrl(media[i]!.id)} alt="" onClick={(e) => e.stopPropagation()} />
      <button type="button" className="rd-light-x" onClick={onClose} aria-label="Fechar"><Icon name="x" size={20} /></button>
      {media.length > 1 && (
        <>
          <button type="button" className="rd-light-nav prev" disabled={i === 0} onClick={(e) => { e.stopPropagation(); setI(i - 1); }} aria-label="Foto anterior"><Icon name="chevron-left" size={22} /></button>
          <button type="button" className="rd-light-nav next" disabled={i === media.length - 1} onClick={(e) => { e.stopPropagation(); setI(i + 1); }} aria-label="Próxima foto"><Icon name="chevron-right" size={22} /></button>
          <span className="rd-light-n">{i + 1} / {media.length}</span>
        </>
      )}
    </div>,
    document.body,
  );
}

const Heart = ({ on, size = 19 }: { on: boolean; size?: number }) => (
  <svg className={`rd-heart${on ? " on" : ""}`} width={size} height={size} viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10" />
  </svg>
);

function PostCard({ post, detail, onPatch, onRemove }: { post: Post; detail?: boolean; onPatch: (c: Partial<Post>) => void; onRemove: () => void }) {
  const { isSuper } = useRede();
  const nav = useNavigate();
  const [menu, setMenu] = useState(false);
  const [likes, setLikes] = useState<Person[] | null | undefined>(undefined);
  const [photo, setPhoto] = useState<number | null>(null);
  const open = () => !detail && nav(`/rede/p/${post.id}`);

  const like = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const on = !post.liked;
    haptic(on ? 12 : 6);
    onPatch({ liked: on, likes: Math.max(0, post.likes + (on ? 1 : -1)) });
    try {
      const r = await api<{ liked: boolean; likes: number }>(`/api/feed/posts/${post.id}/like`, { method: on ? "POST" : "DELETE", headers: quiet });
      onPatch(r);
    } catch {
      onPatch({ liked: post.liked, likes: post.likes });
    }
  };
  const share = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const url = `${location.origin}/rede/p/${post.id}`;
    haptic(6);
    try {
      if (navigator.share) await navigator.share({ url, text: `${post.author.name} no Planejai` });
      else {
        await navigator.clipboard.writeText(url);
        void alertDialog("Link copiado", "Só quem está na rede do Planejai consegue abrir.");
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
    if (!(await confirmDialog({ title: `Bloquear @${post.author.handle}?`, body: "Vocês deixam de se seguir e um não vê mais nada do outro.", confirmLabel: "Bloquear", danger: true }))) return;
    await api(`/api/feed/u/${post.author.handle}/block`, { method: "POST" }).catch(() => {});
    onRemove();
  };

  return (
    <>
    <article className={`rd-post${detail ? " detail" : ""}`} onClick={open} tabIndex={detail ? undefined : 0} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && open()}>
      <Avatar who={post.author} size={detail ? 46 : 42} me={post.mine} />
      <div className="rd-post-main">
        <header>
          <Link to={profilePath(post.author.handle)} onClick={(e) => e.stopPropagation()}>
            <strong>{post.author.name}</strong>
            <span>@{post.author.handle}</span>
          </Link>
          <time dateTime={post.created_at}>· {shortTime(post.created_at)}</time>
          <span className="spacer" />
          <button type="button" className="rd-dots" onClick={(e) => { e.stopPropagation(); haptic(5); setMenu(true); }} aria-label="Mais opções"><Icon name="more" size={18} /></button>
        </header>
        {post.body && <p className="rd-body"><RichText text={post.body} /></p>}
        <Photos media={post.media} onOpen={setPhoto} />
        <footer>
          <button type="button" className={`rd-act${post.liked ? " liked" : ""}`} onClick={like} aria-pressed={post.liked} aria-label={post.liked ? "Tirar curtida" : "Curtir"}>
            <Heart on={post.liked} key={post.liked ? "on" : "off"} />
            {post.likes > 0 && <span>{count(post.likes)}</span>}
          </button>
          <button type="button" className="rd-act" onClick={(e) => { e.stopPropagation(); open(); }} aria-label="Comentar">
            <Icon name="message" size={19} />
            {post.comments > 0 && <span>{count(post.comments)}</span>}
          </button>
          <button type="button" className="rd-act" onClick={share} aria-label="Compartilhar"><Icon name="share" size={19} /></button>
          {detail && post.likes > 0 && <button type="button" className="rd-likers" onClick={showLikes}>Ver quem curtiu</button>}
        </footer>
      </div>
    </article>
      {menu && (
        <Modal title="Publicação" onClose={() => setMenu(false)} bare>
          <div>
            {(post.mine || isSuper) && (
              <button type="button" className="sheet-item rd-danger" onClick={remove}><span className="ico-box"><Icon name="trash" size={17} /></span>Apagar{post.mine ? "" : " (moderação)"}</button>
            )}
            {!post.mine && (
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
  const { profile } = useRede();
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
  const { unread } = useRede();
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
        <Link to="/rede/buscar" className="icon-btn" aria-label="Buscar pessoas"><Icon name="search" size={20} /></Link>
        <Link to="/rede/atividade" className="icon-btn rd-bell" aria-label={unread ? `Atividade, ${unread} novas` : "Atividade"}>
          <Icon name="heart" size={20} />
          {unread > 0 && <i />}
        </Link>
      </div>
      {!phone && <Composer inline onPosted={list.add} />}
      <PostList
        list={list}
        empty={
          tab === "following" ? (
            <Blank title="Ninguém por aqui ainda" text="Siga algumas pessoas e os posts delas aparecem nesta aba." action={<Link className="btn" to="/rede/buscar"><Icon name="search" size={16} /> Encontrar pessoas</Link>} />
          ) : (
            <Blank title="O feed está começando" text="Seja a primeira pessoa a publicar. Vale uma ideia, uma foto ou um status." action={<button type="button" className="btn btn-brand" onClick={() => setWriting(true)}><Icon name="edit" size={16} /> Escrever</button>} />
          )
        }
      />
      {phone &&
        // no <body>: a tela anima com transform, e botão fixo dentro dela ia parar no fim da lista
        createPortal(
          <button type="button" className="fab ink rd-fab" onClick={() => { haptic(8); setWriting(true); }} aria-label="Nova publicação">
            <Icon name="edit" size={21} />
          </button>,
          document.body,
        )}
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
  const { profile, isSuper } = useRede();
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
      <form className="rd-reply" onSubmit={send}>
        <Avatar who={profile} size={34} me link={false} />
        <input value={text} maxLength={COMMENT_MAX} onChange={(e) => setText(e.target.value)} placeholder={`Responder a ${post.author.name.split(" ")[0]}`} aria-label="Escrever comentário" />
        <button type="submit" className="rd-reply-go" disabled={!text.trim() || busy} aria-label="Enviar comentário"><Icon name="arrow-up" size={18} /></button>
      </form>
      {error && <div className="error-box">{error}</div>}
      <div className="rd-comments">
        {comments.map((c) => (
          <div className="rd-comment" key={c.id}>
            <Avatar who={c.author} size={34} me={c.mine} />
            <div>
              <header>
                <Link to={profilePath(c.author.handle)}><strong>{c.author.name}</strong></Link>
                <time dateTime={c.created_at}>{shortTime(c.created_at)}</time>
              </header>
              <p><RichText text={c.body} /></p>
            </div>
            {c.canDelete || isSuper ? (
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

function ProfileScreen() {
  const { handle = "" } = useParams();
  const me = useRede();
  const nav = useNavigate();
  const pick = useCallback((d: any) => ({ posts: d.posts, next: d.next }), []);
  const list = usePosts(`/api/feed/u/${handle}`, pick);
  const [view, setView] = useState<"posts" | "fotos">("posts");
  const [people, setPeople] = useState<{ title: string; list: Person[] | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [delta, setDelta] = useState(0);
  const [photo, setPhoto] = useState<{ media: Photo[]; i: number } | null>(null);
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
    if (!p.blocked && !(await confirmDialog({ title: `Bloquear @${p.handle}?`, body: "Vocês deixam de se seguir e um não vê mais nada do outro.", confirmLabel: "Bloquear", danger: true }))) return;
    await api(`/api/feed/u/${p.handle}/block`, { method: p.blocked ? "DELETE" : "POST" }).catch(() => {});
    void list.reload();
  };
  const report = async () => {
    setMenu(false);
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
  const grid = list.posts.flatMap((post) => post.media.map((m, i) => ({ m, i, post })));

  return (
    <>
      <section className="rd-profile">
        <div className="rd-profile-top">
          <Avatar who={p} size={84} me={p.me} link={false} />
          <div className="rd-stats">
            <span><b>{count(p.posts)}</b> posts</span>
            <button type="button" onClick={() => void openPeople("seguidores")}><b>{count(Math.max(0, p.followers + delta))}</b> seguidores</button>
            <button type="button" onClick={() => void openPeople("seguindo")}><b>{count(p.following)}</b> seguindo</button>
          </div>
        </div>
        <h1>{p.name}</h1>
        <p className="rd-handle">@{p.handle}{p.followsMe && !p.me && <i>Segue você</i>}</p>
        {p.bio && <p className="rd-bio"><RichText text={p.bio} /></p>}
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
      </section>
      {p.blocked ? (
        <p className="rd-none">Você bloqueou este perfil.</p>
      ) : (
        <>
          <div className="rd-bar">
            <div className="rd-tabs" role="tablist" style={{ ["--i" as string]: view === "posts" ? 0 : 1 }}>
              <button type="button" role="tab" aria-selected={view === "posts"} className={view === "posts" ? "on" : ""} onClick={() => setView("posts")}>Publicações</button>
              <button type="button" role="tab" aria-selected={view === "fotos"} className={view === "fotos" ? "on" : ""} onClick={() => setView("fotos")}>Fotos</button>
            </div>
          </div>
          {view === "posts" ? (
            <PostList list={list} empty={<p className="rd-none">{p.me ? "Você ainda não publicou nada." : "Nenhuma publicação ainda."}</p>} />
          ) : grid.length ? (
            <>
              <div className="rd-grid">
                {grid.map(({ m, i, post }) => (
                  <button type="button" key={m.id} onClick={() => setPhoto({ media: post.media, i })} aria-label="Abrir foto">
                    <img src={mediaUrl(m.id)} alt="" loading="lazy" decoding="async" />
                  </button>
                ))}
              </div>
              <LoadMore on={list.hasMore} more={list.more} busy={list.loadingMore} />
            </>
          ) : (
            <p className="rd-none">Nenhuma foto ainda.</p>
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
          ) : (
            <>
              <button type="button" className="sheet-item" onClick={block}><span className="ico-box"><Icon name="eye-off" size={17} /></span>{p.blocked ? "Desbloquear" : "Bloquear"}</button>
              <button type="button" className="sheet-item" onClick={report}><span className="ico-box"><Icon name="shield" size={17} /></span>Denunciar perfil</button>
            </>
          )}
          <button type="button" className="sheet-item" onClick={() => { setMenu(false); void navigator.clipboard?.writeText(`${location.origin}${profilePath(p.handle)}`); }}><span className="ico-box"><Icon name="link" size={17} /></span>Copiar link do perfil</button>
        </Modal>
      )}
      {photo && <Lightbox media={photo.media} start={photo.i} onClose={() => setPhoto(null)} />}
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
  const list = useApi<ActivityItem[]>("/api/feed/activity");
  // abrir a tela marca como visto: a bolinha do coração some
  useEffect(() => {
    if (list.data) me.reload();
  }, [list.data, me.reload]);
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
