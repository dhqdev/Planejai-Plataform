import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api";
import { Mascote } from "../mascote/Mascote";
import "../landing.css";
import "../blog.css";

/**
 * Blog público (/blog e /blog/:slug), aberto com ou sem login, no jeito de revista: capa grande ilustrada, cartões com
 * categoria, título e tempo de leitura, e o post com "Nesta página", ilustração no meio, perguntas frequentes e convite.
 * Os textos e as ilustrações vêm do servidor (blog.ts); o markdown é desenhado aqui com elementos React, sem HTML cru.
 */

interface Card {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  category: string;
  excerpt: string;
  reading_minutes: number;
  published_at: string;
  author: string;
  cover: string | null;
}
interface Post extends Card {
  body: string;
  inline: string | null;
}

const fmtDate = (iso: string) => new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));

/** Cor do fundo enquanto a ilustração não existe (e por trás dela, enquanto carrega), uma por categoria. */
const TINT: Record<string, string> = {
  "Dicas de produtividade": "#ffd9e2",
  "Dinheiro e finanças": "#d7f2df",
  Comparações: "#e6dcff",
  "Inteligência artificial": "#d6ebff",
};

function Cover({ card, eager, big }: { card: Pick<Card, "cover" | "category" | "title">; eager?: boolean; big?: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`bl-cover${big ? " big" : ""}`} style={{ background: TINT[card.category] ?? "#f1ecff" }}>
      {card.cover && !failed ? (
        <img src={card.cover} alt={card.title} loading={eager ? "eager" : "lazy"} decoding="async" onError={() => setFailed(true)} />
      ) : (
        <div className="bl-cover-empty" aria-hidden="true">
          <Mascote size={big ? 120 : 84} mood="happy" still />
        </div>
      )}
    </div>
  );
}

function Byline({ c }: { c: Pick<Card, "author" | "published_at" | "reading_minutes"> }) {
  return (
    <div className="bl-byline">
      <span className="bl-avatar" aria-hidden="true">
        <Mascote size={22} mood="happy" still />
      </span>
      <strong>{c.author}</strong>
      <span aria-hidden="true">·</span>
      <time dateTime={c.published_at}>{fmtDate(c.published_at)}</time>
      <span aria-hidden="true">·</span>
      <span>{c.reading_minutes} min de leitura</span>
    </div>
  );
}

// ---------------------------------------------------------------- markdown simples

/** **negrito**, *itálico* e [link](/caminho ou https://...) dentro de uma linha. */
function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={`${key}-${i++}`}>{m[1]}</strong>);
    else if (m[2]) out.push(<em key={`${key}-${i++}`}>{m[2]}</em>);
    else if (m[3]) {
      const href = m[4]!;
      const ok = href.startsWith("/") || href.startsWith("https://");
      out.push(ok ? <a key={`${key}-${i++}`} href={href} rel={href.startsWith("/") ? undefined : "noopener noreferrer nofollow"} target={href.startsWith("/") ? undefined : "_blank"}>{m[3]}</a> : m[3]);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export const anchor = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

type Block =
  | { t: "h2" | "h3" | "p" | "quote"; text: string }
  | { t: "ul" | "ol"; items: string[] }
  | { t: "table"; head: string[]; rows: string[][] }
  | { t: "image" };

export function parseBody(body: string): Block[] {
  const blocks: Block[] = [];
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!.trim();
    if (!line) {
      i++;
      continue;
    }
    if (line === "[[imagem]]") {
      blocks.push({ t: "image" });
      i++;
    } else if (line.startsWith("### ")) {
      blocks.push({ t: "h3", text: line.slice(4) });
      i++;
    } else if (line.startsWith("## ")) {
      blocks.push({ t: "h2", text: line.slice(3) });
      i++;
    } else if (line.startsWith(">")) {
      const parts: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith(">")) parts.push(lines[i++]!.trim().replace(/^>\s?/, ""));
      blocks.push({ t: "quote", text: parts.join(" ") });
    } else if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i]!.trim())) items.push(lines[i++]!.trim().slice(2));
      blocks.push({ t: "ul", items });
    } else if (/^\d+[.)]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s/.test(lines[i]!.trim())) items.push(lines[i++]!.trim().replace(/^\d+[.)]\s/, ""));
      blocks.push({ t: "ol", items });
    } else if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        const l = lines[i++]!;
        if (!/^\s*\|?\s*:?-{2,}/.test(l)) rows.push(cells(l));
      }
      if (rows.length) blocks.push({ t: "table", head: rows[0]!, rows: rows.slice(1) });
    } else {
      const parts: string[] = [];
      while (i < lines.length && lines[i]!.trim() && !/^(#{2,3}\s|>|[-*]\s|\d+[.)]\s|\||\[\[imagem\]\])/.test(lines[i]!.trim())) parts.push(lines[i++]!.trim());
      blocks.push({ t: "p", text: parts.join(" ") });
    }
  }
  return blocks;
}

function Body({ blocks, image }: { blocks: Block[]; image: ReactNode }) {
  return (
    <div className="bl-prose">
      {blocks.map((b, k) => {
        switch (b.t) {
          case "h2":
            return <h2 key={k} id={anchor(b.text)}>{inline(b.text, k)}</h2>;
          case "h3":
            return <h3 key={k}>{inline(b.text, k)}</h3>;
          case "p":
            return <p key={k}>{inline(b.text, k)}</p>;
          case "quote":
            return <blockquote key={k}>{inline(b.text, k)}</blockquote>;
          case "ul":
            return <ul key={k}>{b.items.map((it, j) => <li key={j}>{inline(it, j)}</li>)}</ul>;
          case "ol":
            return <ol key={k}>{b.items.map((it, j) => <li key={j}>{inline(it, j)}</li>)}</ol>;
          case "table":
            return (
              <div key={k} className="bl-table">
                <table>
                  <thead>
                    <tr>{b.head.map((h, j) => <th key={j}>{inline(h, j)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>{r.map((c, n) => <td key={n}>{inline(c, n)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "image":
            return <Fragment key={k}>{image}</Fragment>;
        }
      })}
    </div>
  );
}

// ---------------------------------------------------------------- moldura (topo e rodapé iguais aos da landing)

function Frame({ children, loggedIn, scroller }: { children: ReactNode; loggedIn: boolean; scroller: React.RefObject<HTMLDivElement | null> }) {
  const nav = useNavigate();
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    nav(e.currentTarget.getAttribute("href") ?? "/");
  };
  return (
    <div className="lp bl" ref={scroller}>
      <header className="lp-nav">
        <div className="lp-wrap lp-nav-row">
          <a href="/" className="lp-logo" aria-label="Planejai, início" onClick={go}>
            <Mascote size={34} mood="happy" still />
            <span>Planejai</span>
          </a>
          <nav className="lp-links bl-links" aria-label="Seções">
            <a href="/" onClick={go}>Início</a>
            <a href="/blog" onClick={go} aria-current="page">Blog</a>
          </nav>
          <div className="lp-nav-cta">
            {loggedIn ? (
              <a className="lp-btn" href="/" onClick={go}>Abrir o painel</a>
            ) : (
              <>
                <a className="lp-btn ghost" href="/login" onClick={go}>Entrar</a>
                <a className="lp-btn lp-nav-main" href="/login?cadastro=1" onClick={go}>Começar</a>
              </>
            )}
          </div>
        </div>
      </header>
      <main>{children}</main>
      <footer className="lp-foot">
        <div className="lp-wrap lp-foot-row">
          <span className="lp-logo">
            <Mascote size={26} still mood="happy" />
            <span>Planejai</span>
          </span>
          <span className="lp-foot-links">
            <a href="/blog" onClick={go}>Blog</a>
            <a href="/blog/feed.xml">RSS</a>
            <a href="/privacidade">Termos e privacidade</a>
          </span>
          <small>Seu assistente pessoal no WhatsApp.</small>
        </div>
      </footer>
    </div>
  );
}

function PostCard({ c, onOpen }: { c: Card; onOpen: (e: MouseEvent<HTMLAnchorElement>) => void }) {
  return (
    <a className="bl-card" href={`/blog/${c.slug}`} onClick={onOpen}>
      <Cover card={c} />
      <div className="bl-card-in">
        <span className="bl-cat">{c.category}</span>
        <h3>{c.title}</h3>
        <Byline c={c} />
      </div>
    </a>
  );
}

// ---------------------------------------------------------------- telas

function BlogIndex({ open }: { open: (e: MouseEvent<HTMLAnchorElement>) => void }) {
  const [category, setCategory] = useState("");
  const [data, setData] = useState<{ categories: string[]; posts: Card[] } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    document.title = "Blog do Planejai: rotina, dinheiro e IA no dia a dia";
    let alive = true;
    api<{ categories: string[]; posts: Card[] }>(`/api/blog/posts${category ? `?category=${encodeURIComponent(category)}` : ""}`).then(
      (d) => alive && setData(d),
      () => alive && setError(true),
    );
    return () => {
      alive = false;
    };
  }, [category]);
  const [first, ...rest] = data?.posts ?? [];
  return (
    <div className="lp-wrap bl-index">
      <div className="bl-head">
        <h1>Blog do Planejai</h1>
        <label className="bl-select">
          <span className="bl-sr">Categoria</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Todas as categorias</option>
            {(data?.categories ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>
      {error && <p className="bl-empty">Não consegui carregar os posts agora. Tente de novo em instantes.</p>}
      {!data && !error && <div className="bl-skeleton" aria-busy="true" />}
      {data && !first && <p className="bl-empty">Nenhum post nesta categoria ainda.</p>}
      {first && (
        <a className="bl-feature" href={`/blog/${first.slug}`} onClick={open}>
          <Cover card={first} eager big />
          <div className="bl-feature-in">
            <span className="bl-cat">{first.category}</span>
            <h2>{first.title}</h2>
            <p>{first.excerpt}</p>
            <Byline c={first} />
          </div>
        </a>
      )}
      {rest.length > 0 && (
        <div className="bl-grid">
          {rest.map((c, i) => (
            <div key={c.id} className={i < 2 ? "bl-cell wide" : "bl-cell"}>
              <PostCard c={c} onOpen={open} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BlogPost({ slug, open, loggedIn }: { slug: string; open: (e: MouseEvent<HTMLAnchorElement>) => void; loggedIn: boolean }) {
  const [data, setData] = useState<{ post: Post; related: Card[] } | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let alive = true;
    setData(null);
    setMissing(false);
    api<{ post: Post; related: Card[] }>(`/api/blog/posts/${encodeURIComponent(slug)}`).then(
      (d) => {
        if (!alive) return;
        setData(d);
        document.title = `${d.post.title} | Blog do Planejai`;
      },
      () => alive && setMissing(true),
    );
    return () => {
      alive = false;
    };
  }, [slug]);
  const blocks = useMemo(() => (data ? parseBody(data.post.body) : []), [data]);
  const toc = blocks.filter((b): b is { t: "h2"; text: string } => b.t === "h2");

  if (missing)
    return (
      <div className="lp-wrap bl-missing">
        <h1>Esse post não existe mais.</h1>
        <a className="lp-btn" href="/blog" onClick={open}>Ver todos os posts</a>
      </div>
    );
  if (!data) return <div className="lp-wrap"><div className="bl-skeleton post" aria-busy="true" /></div>;
  const { post, related } = data;
  const image = post.inline ? (
    <figure className="bl-figure">
      <img src={post.inline} alt="" loading="lazy" decoding="async" />
    </figure>
  ) : null;
  const jump = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  };

  return (
    <article className="bl-post">
      <header className="bl-post-head">
        <nav className="bl-crumbs" aria-label="Você está em">
          <a href="/blog" onClick={open}>Blog</a>
          <span aria-hidden="true">/</span>
          <span>{post.category}</span>
        </nav>
        <h1>{post.title}</h1>
        {post.subtitle && <p className="bl-sub">{post.subtitle}</p>}
        <Byline c={post} />
      </header>
      <div className="bl-hero">
        <Cover card={post} eager big />
      </div>
      <div className="bl-post-body">
        {toc.length > 1 && (
          <nav className="bl-toc" aria-label="Nesta página">
            <strong>Nesta página</strong>
            <ol>
              {toc.map((h) => (
                <li key={h.text}>
                  <a href={`#${anchor(h.text)}`} onClick={(e) => jump(e, anchor(h.text))}>{h.text.replace(/\*\*/g, "")}</a>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <Body blocks={blocks} image={image} />
        <aside className="bl-cta">
          <div className="bl-cta-copy">
            <strong>Um time de assistentes no seu WhatsApp.</strong>
            <span>Agenda, contas, lembretes e gastos numa conversa só. Ele só age depois do seu sim.</span>
          </div>
          <div className="bl-cta-act">
            <Mascote size={64} mood="happy" />
            <a className="lp-btn light" href={loggedIn ? "/" : "/login?cadastro=1"} onClick={open}>
              {loggedIn ? "Abrir o painel" : "Começar agora"}
            </a>
          </div>
        </aside>
        <div className="bl-author">
          <span className="bl-avatar big" aria-hidden="true">
            <Mascote size={44} mood="happy" still />
          </span>
          <div>
            <strong>{post.author}</strong>
            <p>O time que faz o Planejai escreve aqui sobre rotina, dinheiro e inteligência artificial no dia a dia, sempre com dicas para usar já.</p>
          </div>
        </div>
        <a className="bl-back" href="/blog" onClick={open}>← Voltar ao blog</a>
      </div>
      {related.length > 0 && (
        <section className="lp-wrap bl-related">
          <h2>Leia também</h2>
          <div className="bl-grid three">
            {related.map((c) => (
              <div key={c.id} className="bl-cell">
                <PostCard c={c} onOpen={open} />
              </div>
            ))}
          </div>
        </section>
      )}
    </article>
  );
}

/** `embedded`: logado, o blog abre dentro da moldura do app (trilho, barra de cima e abas do celular ficam onde estão). */
export function BlogPage({ loggedIn = false, embedded = false }: { loggedIn?: boolean; embedded?: boolean }) {
  const loc = useLocation();
  const nav = useNavigate();
  const scroller = useRef<HTMLDivElement | null>(null);
  const slug = decodeURIComponent(loc.pathname.replace(/^\/blog\/?/, "").replace(/\/+$/, ""));
  useEffect(() => {
    if (loc.hash) return;
    if (embedded) document.getElementById("conteudo")?.scrollTo({ top: 0 });
    else scroller.current?.scrollTo({ top: 0 });
  }, [loc.pathname, loc.hash, embedded]);
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    nav(e.currentTarget.getAttribute("href") ?? "/blog");
  };
  const content = slug ? <BlogPost slug={slug} open={open} loggedIn={loggedIn} /> : <BlogIndex open={open} />;
  if (embedded) return <div className="lp bl bl-embed" ref={scroller}>{content}</div>;
  return (
    <Frame loggedIn={loggedIn} scroller={scroller}>{content}</Frame>
  );
}
