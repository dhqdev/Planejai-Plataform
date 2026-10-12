import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ago } from "../api";
import { AgentTag, confirmDialog, Empty, ErrorBox, Modal, PageHead } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";

type Fact = { id: string; content: string; category: string | null; source: string; created_at: string };
type Overview = {
  categories: Record<string, string>;
  facts: Fact[];
  style: string | null;
  notes: { agent: string; note: string; persona: string; name: string }[];
  topics: { topic: string; days: number }[];
  last_meeting_at: string | null;
};

const SOURCE: Record<string, string> = { reuniao: "da reunião", pessoa: "você contou", conversa: "da conversa" };

/**
 * "O que ele sabe de mim": fatos por assunto (a reunião das 19h preenche e corrige), jeito de falar,
 * o que cada agente aprendeu e os assuntos frequentes. Cada pessoa vê e edita só o dela.
 */
export function MemoriesPage() {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string | null>(null);
  const [edit, setEdit] = useState<Partial<Fact> | null>(null);
  const { data, error, reload } = useApi<Overview>("/api/memories/overview", { poll: 60000 });
  const cats = data?.categories ?? {};
  const facts = (data?.facts ?? []).filter((m) => (!q || m.content.toLowerCase().includes(q.toLowerCase())) && (!cat || (m.category ?? "outros") === cat));
  const groups = Object.keys(cats)
    .map((k) => ({ key: k, label: cats[k]!, items: facts.filter((f) => (f.category ?? "outros") === k) }))
    .filter((g) => g.items.length);
  const counts = (data?.facts ?? []).reduce<Record<string, number>>((acc, f) => ((acc[f.category ?? "outros"] = (acc[f.category ?? "outros"] ?? 0) + 1), acc), {});

  const forget = async (f: Fact) => {
    if (!(await confirmDialog({ title: "Esquecer isso?", body: f.content, confirmLabel: "Esquecer", danger: true }))) return;
    haptic(10);
    await api(`/api/memories/${f.id}`, { method: "DELETE" });
    void reload();
  };
  const clear = async (path: string, title: string) => {
    if (!(await confirmDialog({ title, confirmLabel: "Esquecer", danger: true }))) return;
    haptic(10);
    await api(path, { method: "DELETE" });
    void reload();
  };

  return (
    <div className="page mem-page">
      <PageHead
        title="O que ele sabe de mim"
        subtitle={
          data?.last_meeting_at
            ? `Ele aprende com as conversas e o time revisa tudo na reunião das 19h. Última reunião ${ago(data.last_meeting_at)}.`
            : "Ele aprende com as conversas e o time revisa tudo na reunião das 19h."
        }
        actions={
          <button className="btn btn-primary" onClick={() => { haptic(); setEdit({ category: cat ?? "perfil", content: "" }); }}>
            <Icon name="plus" size={16} /> Ensinar algo
          </button>
        }
      />
      <ErrorBox error={error} />

      {data && (
        <div className="mem-grid">
          <section className="card mem-facts">
            <div className="mem-tools">
              <input className="input" placeholder="Buscar" value={q} onChange={(e) => setQ(e.target.value)} />
              <div className="mem-cats">
                <button className={`chip ${!cat ? "active" : ""}`} onClick={() => setCat(null)}>Tudo <span className="mono">{data.facts.length}</span></button>
                {Object.keys(cats).filter((k) => counts[k]).map((k) => (
                  <button key={k} className={`chip ${cat === k ? "active" : ""}`} onClick={() => { haptic(5); setCat(cat === k ? null : k); }}>
                    {cats[k]} <span className="mono">{counts[k]}</span>
                  </button>
                ))}
              </div>
            </div>
            {groups.map((g) => (
              <div key={g.key} className="mem-group">
                <h3>{g.label}</h3>
                <ul>
                  {g.items.map((f) => (
                    <li key={f.id} className="mem-fact">
                      <div className="mem-fact-text">
                        <span>{f.content}</span>
                        <small className="muted">{SOURCE[f.source] ?? "da conversa"} · {ago(f.created_at)}</small>
                      </div>
                      <button className="btn btn-sm btn-ghost" aria-label="Editar" onClick={() => setEdit(f)}><Icon name="edit" size={14} /></button>
                      <button className="btn btn-sm btn-ghost" aria-label="Esquecer" onClick={() => void forget(f)}><Icon name="x" size={14} /></button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {!groups.length && (
              <Empty>{data.facts.length ? "Nada com esse filtro." : "Ainda não sei nada sobre você. Conte pelo WhatsApp ou toque em Ensinar algo."}</Empty>
            )}
          </section>

          <aside className="mem-side">
            <section className="card mem-box">
              <div className="mem-box-head">
                <h3>Jeito de falar com você</h3>
                {data.style && <button className="btn btn-sm btn-ghost" aria-label="Esquecer o jeito de falar" onClick={() => void clear("/api/memories/style", "Esquecer o jeito de falar?")}><Icon name="x" size={14} /></button>}
              </div>
              <p className={data.style ? "" : "muted"}>{data.style ?? "Ainda aprendendo. A reunião das 19h anota como você gosta das respostas."}</p>
            </section>

            <section className="card mem-box">
              <h3>O que cada agente aprendeu</h3>
              {data.notes.length ? (
                <ul className="mem-notes">
                  {data.notes.map((n) => (
                    <li key={n.agent}>
                      <div className="mem-box-head">
                        <AgentTag id={n.agent} />
                        <button className="btn btn-sm btn-ghost" aria-label={`Esquecer o que ${n.persona} aprendeu`} onClick={() => void clear(`/api/memories/notes/${n.agent}`, `Esquecer o que ${n.persona} aprendeu?`)}><Icon name="x" size={14} /></button>
                      </div>
                      <p>{n.note}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Cada agente anota aqui o que aprende com você depois de trabalhar.</p>
              )}
            </section>

            {data.topics.length > 0 && (
              <section className="card mem-box">
                <h3>Assuntos que mais aparecem</h3>
                <div className="mem-topics">
                  {data.topics.map((t) => <span key={t.topic} className="chip">{t.topic}</span>)}
                </div>
              </section>
            )}
            <Link to="/reunioes" className="mem-link card">
              <Icon name="sparkle" size={16} />
              <span>Ver as atas das reuniões</span>
              <Icon name="chevron-right" size={16} />
            </Link>
          </aside>
        </div>
      )}

      {edit && <FactModal fact={edit} categories={cats} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} />}
    </div>
  );
}

function FactModal({ fact, categories, onClose, onSaved }: { fact: Partial<Fact>; categories: Record<string, string>; onClose: () => void; onSaved: () => void }) {
  const [content, setContent] = useState(fact.content ?? "");
  const [category, setCategory] = useState(fact.category ?? "outros");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      haptic();
      if (fact.id) await api(`/api/memories/${fact.id}`, { method: "PATCH", json: { content, category } });
      else await api("/api/memories", { method: "POST", json: { content, category } });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={fact.id ? "Corrigir" : "Ensinar algo"}
      onClose={onClose}
      footer={(close) => (
        <>
          <button className="btn btn-ghost" onClick={close}>Cancelar</button>
          <button className="btn btn-primary" disabled={busy || !content.trim()} onClick={() => void save()}>Salvar</button>
        </>
      )}
    >
      <ErrorBox error={err} />
      <div className="field">
        <label htmlFor="mem-text">O que ele deve saber</label>
        <textarea id="mem-text" className="textarea" rows={3} maxLength={400} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Tenho uma filha, a Laura, de 6 anos" />
      </div>
      <div className="field">
        <label htmlFor="mem-cat">Assunto</label>
        <select id="mem-cat" className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
          {Object.entries(categories).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
    </Modal>
  );
}
