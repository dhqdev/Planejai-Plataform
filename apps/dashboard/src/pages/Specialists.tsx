import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { Empty, ErrorBox, Loading, PageHead } from "../components";
import { AgentFace, FACE_COLORS, outfitFor, type Face } from "../faces";
import { Mascote } from "../mascote/Mascote";
import { refreshAll, useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";
import { MeetRecorder } from "./MeetRecorder";

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

/** Fundo do retrato: o pastel da carinha do agente (no escuro vira um tom fundo da mesma cor, ver especialistas.css). */
const tint = (face: Face) => FACE_COLORS[((face.color % FACE_COLORS.length) + FACE_COLORS.length) % FACE_COLORS.length];

/** Fileira que corre para o lado: arrasta no celular, setinhas no notebook (só aparecem quando tem mais para ver). */
function Rail({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: true });
  const check = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdge({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    check();
    const el = ref.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [check, children]);
  const go = (dir: 1 | -1) => {
    haptic(5);
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };
  return (
    <div className="sp-rail-wrap">
      <div ref={ref} className="sp-rail" role="list" aria-label={label} onScroll={check}>
        {children}
      </div>
      {!edge.start && (
        <button className="sp-arrow prev" aria-label="Voltar" onClick={() => go(-1)}>
          <Icon name="chevron-left" size={16} />
        </button>
      )}
      {!edge.end && (
        <button className="sp-arrow next" aria-label="Ver mais" onClick={() => go(1)}>
          <Icon name="chevron-right" size={16} />
        </button>
      )}
    </div>
  );
}

/** Chave de ligar e desligar (no lugar dos botões Ligar/Desligar). */
function Switch({ it, full, t }: { it: Item; full: boolean; t: ReturnType<typeof useToggle> }) {
  if (it.mine) return <span className="sp-switch-row muted">Já vem no seu time</span>;
  const busy = t.busy === it.slug;
  const blocked = !it.active && full;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={it.active}
      aria-label={`${it.active ? "Desligar" : "Ligar"} ${it.persona}`}
      className={`sp-switch-row ${busy ? "busy" : ""}`}
      disabled={busy || blocked}
      onClick={() => void t.toggle(it)}
    >
      <span className={`sp-switch ${it.active ? "on" : ""}`} aria-hidden="true">
        <i />
      </span>
      <span>{busy ? (it.active ? "Desligando" : "Ligando") : it.active ? "No time" : blocked ? "Time cheio" : "Fora do time"}</span>
    </button>
  );
}

/** Retrato do especialista: o Bolinho com a roupa dele, grande, sobre o tom da carinha. Ligado, ele fica vivo. */
function Portrait({ it, size }: { it: Item; size: number }) {
  const on = it.active || it.mine;
  return (
    <span className="sp-art" style={{ "--tint": tint(it.face) } as CSSProperties}>
      <Mascote still={!on} mood={on ? "happy" : "idle"} outfit={outfitFor(it.face)} size={size} title={it.persona} />
    </span>
  );
}

/** Loja de especialistas: cada pessoa monta o próprio time com agentes prontos (até o limite de agentes dela). */
export function SpecialistsPage() {
  const { data, error, reload } = useApi<Store>("/api/store");
  const t = useToggle(reload);
  if (!data && !error) return <Loading />;
  const team = data?.items.filter((i) => i.active || i.mine) ?? [];
  const rest = data?.items.filter((i) => !i.active && !i.mine) ?? [];
  const full = !!data && data.used >= data.max;
  const open = (slug: string) => `/especialistas/${slug}`;
  return (
    <div className="page store-page sp-page">
      <PageHead
        title="Especialistas"
        subtitle="Monte o seu time. Cada um ganha uma aba aqui e atende direto no WhatsApp."
        actions={
          data && (
            <div className="sp-stats" aria-label="Resumo do time">
              <span><Icon name="users" size={14} /> No time <b>{team.length}</b></span>
              <span><Icon name="circle" size={14} /> Vagas <b>{data.used} de {data.max}</b></span>
              <span><Icon name="sparkle" size={14} /> Para chamar <b>{rest.length}</b></span>
            </div>
          )
        }
      />
      <ErrorBox error={error ?? t.error} />
      {data && (
        <>

          <section className="sp-section">
            <h2>Seu time</h2>
            {team.length === 0 ? (
              <p className="muted sp-empty">Ninguém no time ainda. Escolha alguém logo abaixo e ligue a chave.</p>
            ) : (
              <Rail label="Seu time">
                {team.map((it) => (
                  <div key={it.slug} role="listitem" className="sp-item">
                    <Link to={open(it.slug)} className="sp-card" onClick={() => haptic(5)}>
                      <Portrait it={it} size={172} />
                      <span className="sp-label">
                        <strong>{it.persona}</strong>
                        <small>{it.name}</small>
                      </span>
                    </Link>
                    <Switch it={it} full={full} t={t} />
                  </div>
                ))}
              </Rail>
            )}
          </section>

          {rest.length > 0 && (
            <section className="sp-section">
              <h2>Para chamar</h2>
              {full && <p className="muted sp-note">As {data.max} vagas estão ocupadas. Tire alguém do time para chamar outro.</p>}
              <Rail label="Para chamar">
                {rest.map((it) => (
                  <div key={it.slug} role="listitem" className="sp-item wide">
                    <Link to={open(it.slug)} className="sp-sug" onClick={() => haptic(5)}>
                      <Portrait it={it} size={128} />
                      <span className="sp-sug-text">
                        <strong>{it.persona}</strong>
                        <small>{it.name}</small>
                        <p>{it.blurb}</p>
                      </span>
                    </Link>
                    <Switch it={it} full={full} t={t} />
                  </div>
                ))}
              </Rail>
            </section>
          )}
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
          {it.slug === "reunioes" && (it.active || it.mine) && <MeetRecorder />}
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
