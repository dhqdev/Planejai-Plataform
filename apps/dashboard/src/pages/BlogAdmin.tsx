import { ago, api } from "../api";
import { confirmDialog, Empty, ErrorBox, Loading, PageHead } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";

/**
 * Blog no painel (super admin): o post da semana sai sozinho no dia e hora escolhidos; aqui dá para escrever um agora,
 * esconder, apagar e refazer a ilustração. O blog em si é público, em /blog.
 */

interface AdminPost {
  id: string;
  slug: string;
  title: string;
  category: string;
  status: "published" | "hidden";
  source: "seed" | "auto" | "manual";
  published_at: string;
  updated_at: string;
  reading_minutes: number;
  wants_inline: boolean;
  has_cover: boolean;
  has_inline: boolean;
  image_error: string | null;
}
interface Data {
  settings: { auto: boolean; weekday: number; hour: number };
  posts: AdminPost[];
  busy: boolean;
  ready: boolean;
  timezone: string;
}

const DAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const SOURCE: Record<string, string> = { seed: "De partida", auto: "Automático", manual: "Pedido aqui" };

export function BlogAdminPage() {
  const { data, error, reload, setData } = useApi<Data>("/api/blog-admin", { poll: 8000 });
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;
  const s = data.settings;

  const save = async (patch: Partial<Data["settings"]>) => {
    haptic();
    setData({ ...data, settings: { ...s, ...patch } });
    await api("/api/blog-admin/settings", { method: "PUT", json: patch }).catch(() => reload());
  };
  const write = async () => {
    haptic();
    await api("/api/blog-admin/write", { method: "POST" });
    reload();
  };
  const image = async (p: AdminPost, slot: "cover" | "inline") => {
    haptic();
    await api(`/api/blog-admin/${p.id}/image`, { method: "POST", json: { slot } });
    reload();
  };
  const toggle = async (p: AdminPost) => {
    haptic();
    await api(`/api/blog-admin/${p.id}`, { method: "PATCH", json: { status: p.status === "published" ? "hidden" : "published" } });
    reload();
  };
  const remove = async (p: AdminPost) => {
    if (!(await confirmDialog({ title: "Apagar este post?", body: `"${p.title}" sai do blog de vez, com as ilustrações.`, confirmLabel: "Apagar", danger: true }))) return;
    await api(`/api/blog-admin/${p.id}`, { method: "DELETE" });
    reload();
  };
  const busy = data.busy;

  return (
    <div className="page blog-admin">
      <PageHead
        title="Blog"
        subtitle="Um post novo por semana, escrito e ilustrado pelo time. O blog é público e fica em /blog."
        actions={
          <>
            <a className="btn" href="/blog" target="_blank" rel="noopener">
              <Icon name="external" size={16} /> Abrir o blog
            </a>
            <button className="btn btn-primary" onClick={write} disabled={!data.ready || busy}>
              <Icon name="edit" size={16} /> {busy ? "Escrevendo..." : "Escrever um post agora"}
            </button>
          </>
        }
      />
      {!data.ready && (
        <div className="card card-pad">
          <strong>Falta a chave do OpenRouter</strong>
          <p className="muted">Sem OPENROUTER_API_KEY na stack o time não escreve posts nem gera ilustrações.</p>
        </div>
      )}
      <div className="card card-pad blog-admin-auto">
        <label className="set-switch">
          <input type="checkbox" checked={s.auto} onChange={(e) => save({ auto: e.target.checked })} />
          <span>
            <strong>Postar sozinho toda semana</strong>
            <small>O redator escolhe um tema novo, alternando as categorias, e o modelo de imagem faz a capa e a ilustração do meio. Os modelos ficam em Agentes &gt; Modelos (Blog e Imagens).</small>
          </span>
        </label>
        <div className="blog-admin-when">
          <span className="muted">Toda</span>
          <select className="select" value={s.weekday} disabled={!s.auto} onChange={(e) => save({ weekday: Number(e.target.value) })} aria-label="Dia da semana">
            {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
          <span className="muted">às</span>
          <select className="select" value={s.hour} disabled={!s.auto} onChange={(e) => save({ hour: Number(e.target.value) })} aria-label="Hora">
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}h</option>)}
          </select>
        </div>
      </div>
      {busy && <p className="muted blog-admin-note">O time está escrevendo ou ilustrando. O post aparece aqui em um ou dois minutos.</p>}
      {data.posts.length === 0 ? (
        <Empty>Nenhum post ainda. Os de partida entram sozinhos na primeira hora depois da atualização.</Empty>
      ) : (
        <div className="card blog-admin-list">
          {data.posts.map((p) => (
            <div key={p.id} className="blog-admin-row">
              <a className="blog-admin-thumb" href={`/blog/${p.slug}`} target="_blank" rel="noopener" aria-label={`Abrir ${p.title}`}>
                {p.has_cover ? <img src={`/api/blog/img/${p.id}/cover?v=${new Date(p.updated_at).getTime()}`} alt="" loading="lazy" /> : <Icon name="book" size={20} />}
              </a>
              <div className="blog-admin-main">
                <strong>{p.title}</strong>
                <div className="blog-admin-meta">
                  <span>{p.category}</span>
                  <span>·</span>
                  <span>{ago(p.published_at)}</span>
                  <span>·</span>
                  <span>{SOURCE[p.source] ?? p.source}</span>
                  {p.status === "hidden" && <span className="badge badge-warn">Escondido</span>}
                  {!p.has_cover && <span className="badge">Sem capa</span>}
                  {p.wants_inline && !p.has_inline && <span className="badge">Sem ilustração do meio</span>}
                </div>
                {p.image_error && (!p.has_cover || (p.wants_inline && !p.has_inline)) && <small className="blog-admin-err">Imagem falhou: {p.image_error}</small>}
              </div>
              <div className="blog-admin-act">
                <button className="btn btn-sm" onClick={() => image(p, "cover")} disabled={!data.ready} title="Gerar a capa de novo">
                  <Icon name="refresh" size={14} /> Capa
                </button>
                {p.wants_inline && (
                  <button className="btn btn-sm" onClick={() => image(p, "inline")} disabled={!data.ready} title="Gerar a ilustração do meio de novo">
                    <Icon name="refresh" size={14} /> Meio
                  </button>
                )}
                <button className="btn btn-sm" onClick={() => toggle(p)}>
                  <Icon name={p.status === "published" ? "eye" : "check"} size={14} /> {p.status === "published" ? "Esconder" : "Publicar"}
                </button>
                <button className="btn btn-sm" onClick={() => remove(p)} aria-label="Apagar">
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
