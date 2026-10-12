import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { Empty, ErrorBox, Loading, PageHead } from "../components";
import { AgentFace, type Face } from "../faces";
import { refreshAll, useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";

type Item = {
  slug: string;
  name: string;
  persona: string;
  icon: string;
  blurb: string;
  focus: string;
  asks: string[];
  active: boolean;
  mine: boolean;
  face: Face;
};
type Store = { items: Item[]; used: number; max: number; assistant: string | null };

/** Liga ou desliga um especialista; recarrega as telas abertas (o menu ganha ou perde a aba dele). */
function useToggle(reload: () => Promise<unknown>) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = async (it: Item) => {
    haptic();
    setBusy(it.slug);
    setError(null);
    try {
      await api(`/api/store/${it.slug}`, { method: it.active ? "DELETE" : "POST" });
      await reload();
      void refreshAll();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, toggle };
}

/** Loja de especialistas: cada pessoa monta o próprio time com agentes prontos (até o limite de agentes dela). */
export function SpecialistsPage() {
  const { data, error, reload } = useApi<Store>("/api/store");
  const t = useToggle(reload);
  if (!data && !error) return <Loading />;
  return (
    <div className="page store-page">
      <PageHead title="Especialistas" subtitle="Ligue quem você quer no seu time. Cada um ganha uma aba aqui e atende direto no WhatsApp." />
      <ErrorBox error={error ?? t.error} />
      {data && (
        <>
          <p className="muted store-count">
            {data.used} de {data.max} vagas do seu time em uso
          </p>
          <div className="store-grid">
            {data.items.map((it) => (
              <article key={it.slug} className={`card store-card ${it.active ? "on" : ""}`}>
                <Link to={`/especialistas/${it.slug}`} className="store-card-main" onClick={() => haptic(5)}>
                  <AgentFace face={it.face} size={52} title={it.persona} agent={`c_${it.slug}`} />
                  <div>
                    <strong>{it.name}</strong>
                    <span className="muted">{it.persona}</span>
                    <p>{it.blurb}</p>
                  </div>
                </Link>
                {it.mine ? (
                  <span className="badge">Já tem no seu time</span>
                ) : (
                  <button
                    className={`btn btn-sm ${it.active ? "" : "btn-primary"}`}
                    disabled={t.busy === it.slug || (!it.active && data.used >= data.max)}
                    onClick={() => void t.toggle(it)}
                  >
                    {t.busy === it.slug ? "…" : it.active ? "Desligar" : "Ligar"}
                  </button>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Aba de um especialista: quem é, o que faz e pedidos prontos que abrem o WhatsApp já escritos. */
export function SpecialistPage() {
  const { slug } = useParams();
  const nav = useNavigate();
  const { data, error, reload } = useApi<Store>("/api/store");
  const t = useToggle(reload);
  const [copied, setCopied] = useState<string | null>(null);
  if (!data && !error) return <Loading />;
  const it = data?.items.find((i) => i.slug === slug);
  if (data && !it) return <div className="page"><Empty>Esse especialista não existe. <Link to="/especialistas">Ver todos</Link></Empty></div>;

  const ask = async (text: string) => {
    haptic(5);
    const msg = `${it!.persona}, ${text[0]!.toLowerCase()}${text.slice(1)}`;
    if (data?.assistant) {
      window.open(`https://wa.me/${data.assistant}?text=${encodeURIComponent(msg)}`, "_blank", "noopener");
      return;
    }
    await navigator.clipboard?.writeText(msg).catch(() => {});
    setCopied(text);
    setTimeout(() => setCopied(null), 1800);
  };

  return (
    <div className="page store-page">
      <ErrorBox error={error ?? t.error} />
      {it && (
        <>
          <section className="card store-hero">
            <AgentFace face={it.face} size={84} title={it.persona} agent={`c_${it.slug}`} live />
            <div>
              <h1>{it.persona}</h1>
              <span className="muted">Especialista em {it.name}</span>
              <p>{it.blurb}</p>
            </div>
          </section>
          {it.active || it.mine ? (
            <section className="card store-asks">
              <h3>Peça no WhatsApp</h3>
              <p className="muted">{data?.assistant ? "Toque e a mensagem já abre escrita." : "Toque para copiar e cole na conversa com o assistente."}</p>
              <ul>
                {it.asks.map((a) => (
                  <li key={a}>
                    <button className="store-ask" onClick={() => void ask(a)}>
                      <span>{a}</span>
                      <Icon name={copied === a ? "check" : data?.assistant ? "send" : "copy"} size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <section className="card store-asks">
              <h3>Ainda não está no seu time</h3>
              <p className="muted">Ligue para {it.persona} cuidar de {it.focus}.</p>
            </section>
          )}
          <div className="store-actions">
            <button className="btn" onClick={() => { haptic(5); nav("/especialistas"); }}>
              <Icon name="chevron-left" size={16} /> Todos os especialistas
            </button>
            {!it.mine && (
              <button className={`btn ${it.active ? "" : "btn-primary"}`} disabled={t.busy === it.slug || (!it.active && data!.used >= data!.max)} onClick={() => void t.toggle(it)}>
                {t.busy === it.slug ? "…" : it.active ? `Desligar ${it.persona}` : `Ligar ${it.persona}`}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
