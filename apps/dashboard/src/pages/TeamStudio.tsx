import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { ago, api } from "../api";
import { confirmDialog, ErrorBox, Loading } from "../components";
import { AgentFace, type Face } from "../faces";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";
import "../styles/estudio.css";

/**
 * Mapa do time em tela cheia (só o dono), no jeito do editor do n8n: cada agente nosso é um bloco no quadro,
 * as linhas mostram quem fala com quem (com quantas vezes em 7 dias) e, aberto, o bloco mostra o que ele recebe,
 * o prompt (editável) e o que devolve, com o último trabalho dele nas conversas do próprio dono.
 */

interface Field {
  key: "role" | "instructions";
  label: string;
  help: string;
  value: string;
  default: string;
  edited: boolean;
}
interface ToolInfo {
  name: string;
  description: string;
  integration: string | null;
  available: boolean;
  group: string | null;
}
interface SNode {
  id: string;
  kind: "pessoa" | "cto" | "specialist" | "regras" | "bastidor";
  name: string;
  persona?: string;
  face?: Face;
  icon: string;
  model?: string | null;
  summary: string;
  fields: Field[];
  auto?: string[];
  readOnly?: string | null;
  warn?: string | null;
  tools: ToolInfo[];
  preview: string;
  receives: string;
  returns: string;
  calls7d: number;
  edited: boolean;
  baseChanged?: boolean;
  updatedAt?: string | null;
}
interface SEdge {
  from: string;
  to: string;
  kind: "mensagem" | "ask" | "consult" | "usa" | "nota";
  label: string;
  n: number;
}
type Pt = { x: number; y: number };
type View = { x: number; y: number; k: number };

const W = 232;
const H = 68;
const MIN_K = 0.3;
const MAX_K = 1.8;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Da esquerda para a direita, como um fluxo: quem manda, o CTO, os especialistas e os bastidores. */
function layout(nodes: SNode[]): Record<string, Pt> {
  const pos: Record<string, Pt> = {};
  const specs = nodes.filter((n) => n.kind === "specialist");
  const back = nodes.filter((n) => n.kind === "bastidor" && n.id !== "visao" && n.id !== "reuniao");
  const gap = 104;
  const mid = ((specs.length - 1) * gap) / 2;
  specs.forEach((n, i) => (pos[n.id] = { x: 720, y: i * gap - mid }));
  back.forEach((n, i) => (pos[n.id] = { x: 1110, y: i * 128 - ((back.length - 1) * 128) / 2 }));
  pos.pessoa = { x: 0, y: -60 };
  pos.visao = { x: 0, y: 90 };
  pos.cto = { x: 340, y: 0 };
  pos.reuniao = { x: 340, y: mid + 40 };
  pos._time = { x: 720, y: -mid - 150 };
  return pos;
}

/** Linha de saída (direita) para entrada (esquerda). Mesma coluna: faz a volta pela direita. */
function edgePath(a: Pt, b: Pt) {
  const x1 = a.x + W;
  const y1 = a.y + H / 2;
  if (Math.abs(a.x - b.x) < 10) {
    const x2 = b.x + W;
    const y2 = b.y + H / 2;
    const out = 60 + Math.min(Math.abs(y2 - y1) * 0.25, 120);
    return { d: `M${x1} ${y1} C${x1 + out} ${y1} ${x2 + out} ${y2} ${x2} ${y2}`, mid: { x: x1 + out * 0.75, y: (y1 + y2) / 2 } };
  }
  const x2 = b.x;
  const y2 = b.y + H / 2;
  const c = Math.max(60, Math.abs(x2 - x1) * 0.45);
  return { d: `M${x1} ${y1} C${x1 + c} ${y1} ${x2 - c} ${y2} ${x2} ${y2}`, mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 } };
}

const KIND_LABEL: Record<SNode["kind"], string> = { pessoa: "Gatilho", cto: "Orquestrador", specialist: "Especialista", regras: "Regras", bastidor: "Bastidor" };
const shortModel = (m?: string | null) => (m ? (m.split("/").pop() ?? m) : "");

export function TeamStudioPage() {
  const { data, error, reload } = useApi<{ nodes: SNode[]; edges: SEdge[] }>("/api/studio");
  const nav = useNavigate();
  const [open, setOpen] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  // tela cheia de verdade: some a rolagem da página e Esc fecha (o bloco aberto antes, depois a tela)
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".modal-bg")) return;
      if (open) setOpen(null);
      else nav("/agents");
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, nav]);

  const node = data?.nodes.find((n) => n.id === open) ?? null;
  const edited = data?.nodes.filter((n) => n.edited).length ?? 0;

  return createPortal(
    <div className="studio" role="dialog" aria-modal="true" aria-label="Mapa do time">
      <header className="studio-top">
        <Link className="btn" to="/agents" aria-label="Voltar para Agentes">
          <Icon name="chevron-left" size={16} /> Voltar
        </Link>
        <div className="studio-title">
          <strong>Mapa do time</strong>
          <small>Prompts e conversas dos nossos agentes · só você vê</small>
        </div>
        <span className="spacer" />
        <div className="studio-legend" aria-hidden="true">
          <span><i className="lg-ask" /> CTO pede</span>
          <span><i className="lg-consult" /> colega consulta</span>
          <span><i className="lg-usa" /> usa por ferramenta</span>
        </div>
        {edited > 0 && <span className="chip">{edited} editado{edited > 1 ? "s" : ""}</span>}
      </header>
      {error ? (
        <div className="studio-msg"><ErrorBox error={error} /></div>
      ) : !data ? (
        <div className="studio-msg"><Loading /></div>
      ) : (
        <Canvas data={data} open={open} hover={hover} onHover={setHover} onOpen={setOpen} />
      )}
      {node && data && <NodeView node={node} edges={data.edges} nodes={data.nodes} onClose={() => setOpen(null)} onJump={setOpen} onSaved={reload} />}
    </div>,
    document.body,
  );
}

function Canvas({ data, open, hover, onHover, onOpen }: { data: { nodes: SNode[]; edges: SEdge[] }; open: string | null; hover: string | null; onHover: (id: string | null) => void; onOpen: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const pos = useMemo(() => layout(data.nodes), [data.nodes]);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const touched = useRef(false);

  const fit = useCallback(() => {
    const el = box.current;
    const pts = Object.values(pos);
    if (!el || !pts.length) return;
    const x0 = Math.min(...pts.map((p) => p.x)) - 40;
    const x1 = Math.max(...pts.map((p) => p.x)) + W + 120;
    const y0 = Math.min(...pts.map((p) => p.y)) - 40;
    const y1 = Math.max(...pts.map((p) => p.y)) + H + 40;
    // celular em pé: o fluxo todo ficaria minúsculo; mostra o CTO e os especialistas legíveis e o resto fica a um arrasto
    if (el.clientWidth < 640) {
      const k = clamp(el.clientHeight / (y1 - y0), 0.45, 0.62);
      const cx = ((pos.cto?.x ?? 0) + (pos.pesquisador?.x ?? 0) + W) / 2; // entre o CTO e a coluna dos especialistas
      setView({ k, x: el.clientWidth / 2 - k * cx, y: el.clientHeight / 2 - k * ((y0 + y1) / 2) });
      return;
    }
    const k = clamp(Math.min(el.clientWidth / (x1 - x0), el.clientHeight / (y1 - y0)), MIN_K, 1.15);
    setView({ k, x: el.clientWidth / 2 - k * ((x0 + x1) / 2), y: el.clientHeight / 2 - k * ((y0 + y1) / 2) });
  }, [pos]);

  useEffect(() => {
    fit();
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => !touched.current && fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  const zoomAt = useCallback((f: number, x: number, y: number) => {
    touched.current = true;
    setView((v) => {
      const k = clamp(v.k * f, MIN_K, MAX_K);
      return { k, x: x - (x - v.x) * (k / v.k), y: y - (y - v.y) * (k / v.k) };
    });
  }, []);

  // roda: rola o quadro; com Ctrl (ou pinça no trackpad): zoom, como no n8n
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
      else {
        touched.current = true;
        setView((v) => ({ ...v, x: v.x - (e.shiftKey ? e.deltaY : e.deltaX), y: v.y - (e.shiftKey ? 0 : e.deltaY) }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // arrastar o fundo (um dedo ou o mouse) move; dois dedos movem e dão zoom
  const ptrs = useRef(new Map<number, Pt>());
  const pinch = useRef<{ d: number; c: Pt; v: View } | null>(null);
  const moved = useRef(false);
  const [panning, setPanning] = useState(false);
  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest(".st-node, .st-ctrl")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!ptrs.current.size) moved.current = false;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size === 2) {
      const [a, b] = [...ptrs.current.values()] as [Pt, Pt];
      const r = e.currentTarget.getBoundingClientRect();
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), c: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top }, v: view };
    }
    setPanning(true);
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const last = ptrs.current.get(e.pointerId);
    if (!last) return;
    moved.current = true;
    touched.current = true;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size >= 2 && pinch.current) {
      const [a, b] = [...ptrs.current.values()] as [Pt, Pt];
      const r = e.currentTarget.getBoundingClientRect();
      const p = pinch.current;
      const k = clamp((p.v.k * Math.hypot(a.x - b.x, a.y - b.y)) / Math.max(p.d, 1), MIN_K, MAX_K);
      const c = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      setView({ k, x: c.x - ((p.c.x - p.v.x) / p.v.k) * k, y: c.y - ((p.c.y - p.v.y) / p.v.k) * k });
    } else setView((v) => ({ ...v, x: v.x + e.clientX - last.x, y: v.y + e.clientY - last.y }));
  };
  const up = (e: RPointerEvent<HTMLDivElement>) => {
    ptrs.current.delete(e.pointerId);
    if (ptrs.current.size < 2) pinch.current = null;
    if (!ptrs.current.size) setPanning(false);
  };

  const focus = hover ?? open;
  const near = (e: SEdge) => !focus || e.from === focus || e.to === focus;
  const max = Math.max(1, ...data.edges.map((e) => e.n));
  const center = () => ({ x: (box.current?.clientWidth ?? 0) / 2, y: (box.current?.clientHeight ?? 0) / 2 });

  return (
    <div
      ref={box}
      className={`studio-canvas ${panning ? "panning" : ""}`}
      style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${20 * view.k}px ${20 * view.k}px` }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <div className="st-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg className="st-links" width={1} height={1} aria-hidden="true">
          {data.edges.map((e) => {
            const a = pos[e.from];
            const b = pos[e.to];
            if (!a || !b) return null;
            const { d } = edgePath(a, b);
            return (
              <path
                key={`${e.from}>${e.to}>${e.kind}`}
                d={d}
                className={`st-link k-${e.kind} ${e.n ? "hot" : ""} ${near(e) ? (focus ? "on" : "") : "dim"}`}
                style={e.n ? { strokeWidth: 1.6 + (e.n / max) * 2.6 } : undefined}
              />
            );
          })}
        </svg>
        {data.edges.map((e) => {
          const a = pos[e.from];
          const b = pos[e.to];
          if (!a || !b || (!e.n && !(focus && near(e)))) return null;
          const { mid } = edgePath(a, b);
          return (
            <span key={`l:${e.from}>${e.to}>${e.kind}`} className={`st-label ${near(e) ? "" : "dim"}`} style={{ left: mid.x, top: mid.y }}>
              {focus && near(e) ? e.label : ""}
              {e.n ? <b>{e.n}×</b> : null}
            </span>
          );
        })}
        {data.nodes.map((n) => {
          const p = pos[n.id];
          if (!p) return null;
          const dim = focus && focus !== n.id && !data.edges.some((e) => (e.from === focus && e.to === n.id) || (e.to === focus && e.from === n.id));
          return (
            <button
              key={n.id}
              className={`st-node k-${n.kind} ${open === n.id ? "sel" : ""} ${dim ? "dim" : ""}`}
              style={{ left: p.x, top: p.y, width: W, height: H }}
              onClick={() => !moved.current && (haptic(), onOpen(n.id))}
              onMouseEnter={() => onHover(n.id)}
              onMouseLeave={() => onHover(null)}
            >
              <span className="st-in" aria-hidden="true" />
              <span className="st-out" aria-hidden="true" />
              <span className="st-ico">{n.face ? <AgentFace face={n.face} size={40} agent={n.id} /> : <Icon name={n.icon} size={20} />}</span>
              <span className="st-txt">
                <strong>{n.persona && n.kind !== "pessoa" && n.kind !== "regras" ? n.persona : n.name}</strong>
                <small>{[n.persona && n.kind !== "pessoa" && n.kind !== "regras" ? n.name : KIND_LABEL[n.kind], shortModel(n.model)].filter(Boolean).join(" · ")}</small>
              </span>
              {n.edited && <span className="st-badge" title="Prompt editado por você">editado</span>}
              {n.calls7d > 0 && <span className="st-calls" title="Passos nos últimos 7 dias">{n.calls7d}</span>}
            </button>
          );
        })}
      </div>
      <div className="st-ctrl" role="toolbar" aria-label="Zoom">
        <button className="icon-btn" aria-label="Aproximar" onClick={() => zoomAt(1.25, center().x, center().y)}>
          <Icon name="plus" size={16} />
        </button>
        <button className="icon-btn" aria-label="Afastar" onClick={() => zoomAt(0.8, center().x, center().y)}>
          <svg width={16} height={16} viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" /></svg>
        </button>
        <button className="icon-btn" aria-label="Enquadrar todos" onClick={() => ((touched.current = false), fit())}>
          <Icon name="resize" size={15} />
        </button>
      </div>
      <div className="st-hint">Toque num agente para ver o que ele recebe, o prompt e o que devolve.</div>
    </div>
  );
}

type Pane = "entrada" | "prompt" | "saida";

function NodeView({ node, nodes, edges, onClose, onJump, onSaved }: { node: SNode; nodes: SNode[]; edges: SEdge[]; onClose: () => void; onJump: (id: string) => void; onSaved: () => void }) {
  const [pane, setPane] = useState<Pane>("prompt");
  const last = useApi<{ run: any; reason: string | null }>(node.kind === "pessoa" || node.kind === "regras" ? null : `/api/studio/${node.id}/last`);
  const nameOf = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    return n ? (n.persona && n.kind !== "pessoa" && n.kind !== "regras" ? `${n.persona} (${n.name})` : n.name) : id;
  };
  const inbound = edges.filter((e) => e.to === node.id);
  const outbound = edges.filter((e) => e.from === node.id);
  const run = last.data?.run;
  const title = node.persona && node.kind !== "pessoa" && node.kind !== "regras" ? `${node.persona} · ${node.name}` : node.name;

  return (
    <div className="st-ndv-bg" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="st-ndv" aria-label={title}>
        <header className="st-ndv-head">
          <span className="st-ico">{node.face ? <AgentFace face={node.face} size={36} agent={node.id} live /> : <Icon name={node.icon} size={20} />}</span>
          <div className="st-ndv-title">
            <strong>{title}</strong>
            <small>{[KIND_LABEL[node.kind], node.model, node.calls7d ? `${node.calls7d} passos em 7 dias` : ""].filter(Boolean).join(" · ")}</small>
          </div>
          <span className="spacer" />
          <div className="seg st-panes" role="tablist" aria-label="Parte">
            {(["entrada", "prompt", "saida"] as Pane[]).map((p) => (
              <button key={p} role="tab" aria-selected={pane === p} className={pane === p ? "active" : ""} onClick={() => setPane(p)}>
                {p === "entrada" ? "Entrada" : p === "prompt" ? "Prompt" : "Saída"}
              </button>
            ))}
          </div>
          <button className="icon-btn" aria-label="Fechar" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <p className="st-summary">{node.summary}</p>
        <div className={`st-cols show-${pane}`}>
          <div className="st-col st-col-in">
            <h4>Entrada</h4>
            <p className="muted">{node.receives}</p>
            {inbound.length > 0 && (
              <>
                <h5>Quem chama</h5>
                <Links list={inbound.map((e) => ({ id: e.from, label: e.label, n: e.n, kind: e.kind }))} nameOf={nameOf} onJump={onJump} />
              </>
            )}
            {node.kind !== "pessoa" && node.kind !== "regras" && <LastRun part="input" run={run} reason={last.data?.reason ?? null} loading={last.loading} />}
          </div>
          <div className="st-col st-col-mid">
            <PromptEditor key={node.id} node={node} onSaved={onSaved} />
            {node.tools.length > 0 && <Tools tools={node.tools} />}
          </div>
          <div className="st-col st-col-out">
            <h4>Saída</h4>
            {node.returns && <p className="muted">{node.returns}</p>}
            {outbound.length > 0 && (
              <>
                <h5>Fala com</h5>
                <Links list={outbound.map((e) => ({ id: e.to, label: e.label, n: e.n, kind: e.kind }))} nameOf={nameOf} onJump={onJump} />
              </>
            )}
            {node.kind === "specialist" && (
              <>
                <h5>Pode consultar (consult_colega)</h5>
                <div className="st-peers">
                  {nodes
                    .filter((x) => x.kind === "specialist" && x.id !== node.id)
                    .map((x) => (
                      <button key={x.id} className="chip" onClick={() => onJump(x.id)}>{x.persona ?? x.name}</button>
                    ))}
                </div>
              </>
            )}
            {node.kind !== "pessoa" && node.kind !== "regras" && <LastRun part="output" run={run} reason={last.data?.reason ?? null} loading={last.loading} />}
          </div>
        </div>
      </section>
    </div>
  );
}

function Links({ list, nameOf, onJump }: { list: { id: string; label: string; n: number; kind: string }[]; nameOf: (id: string) => string; onJump: (id: string) => void }) {
  return (
    <ul className="st-links-list">
      {list.map((l) => (
        <li key={`${l.id}:${l.kind}`}>
          <button className="st-jump" onClick={() => onJump(l.id)}>
            <span>{nameOf(l.id)}</span>
            <small className="mono">{l.label}</small>
            {l.n > 0 && <b>{l.n}× em 7 dias</b>}
            <Icon name="chevron-right" size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function PromptEditor({ node, onSaved }: { node: SNode; onSaved: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(node.fields.map((f) => [f.key, f.value])));
  const [view, setView] = useState<"editar" | "completo">(node.fields.length ? "editar" : "completo");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const dirty = node.fields.some((f) => (draft[f.key] ?? "") !== f.value);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ edited: boolean }>(`/api/studio/${node.id}`, { method: "PUT", json: draft });
      haptic(12);
      setMsg(r.edited ? "Salvo. Vale para as próximas mensagens (em até 15 segundos)." : "Igual ao padrão: voltou a seguir o texto do código.");
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    const ok = await confirmDialog({ title: "Voltar ao prompt padrão?", body: "O texto editado some e o agente volta a seguir o que está no código.", confirmLabel: "Voltar ao padrão", danger: true });
    if (!ok) return;
    setBusy(true);
    try {
      await api(`/api/studio/${node.id}`, { method: "DELETE" });
      setDraft(Object.fromEntries(node.fields.map((f) => [f.key, f.default])));
      setMsg("Voltou ao padrão.");
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="st-prompt">
      <div className="st-prompt-head">
        <h4>Prompt</h4>
        {node.preview && node.fields.length > 0 && (
          <div className="seg" role="group" aria-label="Mostrar">
            <button className={view === "editar" ? "active" : ""} onClick={() => setView("editar")}>Editar</button>
            <button className={view === "completo" ? "active" : ""} onClick={() => setView("completo")}>Como ele recebe</button>
          </div>
        )}
      </div>
      {node.baseChanged && <div className="notice">O texto padrão deste agente mudou no código depois da sua edição. Confira em "Voltar ao padrão" se quiser a versão nova.</div>}
      {node.warn && <div className="notice">{node.warn}</div>}
      {node.readOnly && <p className="muted">{node.readOnly}</p>}
      {view === "completo" || !node.fields.length ? (
        node.preview ? (
          <>
            {node.fields.length > 0 && <p className="muted st-note">Com uma pessoa de exemplo. Data, memórias e o resto do contexto mudam a cada mensagem.</p>}
            <pre className="st-pre">{node.preview}</pre>
          </>
        ) : (
          !node.readOnly && <p className="muted">Este bloco não tem prompt: é de onde a conversa começa.</p>
        )
      ) : (
        <>
          {node.fields.map((f) => (
            <label key={f.key} className="st-field">
              <span className="st-field-top">
                <strong>{f.label}</strong>
                <small className="muted">{(draft[f.key] ?? "").length.toLocaleString("pt-BR")} caracteres</small>
              </span>
              <small className="muted">{f.help}</small>
              <textarea
                className="textarea st-area"
                spellCheck={false}
                value={draft[f.key] ?? ""}
                rows={f.key === "role" ? 3 : 14}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            </label>
          ))}
          {node.auto && (
            <div className="st-auto">
              <strong>Entra sozinho, sem editar</strong>
              <ul>{node.auto.map((a) => <li key={a}>{a}</li>)}</ul>
            </div>
          )}
          <div className="st-actions">
            {node.edited && (
              <button className="btn" disabled={busy} onClick={restore}>
                <Icon name="refresh" size={15} /> Voltar ao padrão
              </button>
            )}
            {dirty && (
              <button className="btn" disabled={busy} onClick={() => (setDraft(Object.fromEntries(node.fields.map((f) => [f.key, f.value]))), setMsg(null))}>
                Desfazer
              </button>
            )}
            <span className="spacer" />
            {node.updatedAt && !dirty && <small className="muted">Editado {ago(node.updatedAt)}</small>}
            <button className="btn btn-primary" disabled={!dirty || busy} onClick={save}>
              {busy ? "Salvando…" : "Salvar"}
            </button>
          </div>
          {msg && <p className="st-msg" role="status">{msg}</p>}
        </>
      )}
    </div>
  );
}

function Tools({ tools }: { tools: ToolInfo[] }) {
  const [openList, setOpenList] = useState(false);
  const base = tools.filter((t) => !t.group);
  const extra = tools.filter((t) => t.group);
  return (
    <div className="st-tools">
      <button className="st-tools-head" aria-expanded={openList} onClick={() => setOpenList((o) => !o)}>
        <strong>Ferramentas que ele vê</strong>
        <span className="muted">{tools.length}</span>
        <Icon name="chevron-right" size={14} className={openList ? "st-rot" : ""} />
      </button>
      {openList && (
        <ul>
          {[...base, ...extra].map((t) => (
            <li key={`${t.group}:${t.name}`} className={t.available ? "" : "off"}>
              <span className="mono">{t.name}</span>
              {t.group && <span className="chip">{t.group === "time" ? "time" : `só com assunto: ${t.group}`}</span>}
              {!t.available && <span className="chip">conectar {t.integration}</span>}
              <small className="muted">{t.description}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Mensagens do passo (o runner guarda as 6 últimas) ou o que a ferramenta recebeu. */
function messagesOf(input: any): { role: string; text: string }[] {
  if (!input) return [];
  if (Array.isArray(input.messages))
    return input.messages.map((m: any) => ({
      role: m.role ?? "?",
      text: typeof m.content === "string" ? m.content : m.tool_calls ? m.tool_calls.map((c: any) => `${c.function?.name}(${c.function?.arguments ?? ""})`).join("\n") : JSON.stringify(m.content ?? "", null, 1),
    }));
  return [{ role: "entrada", text: typeof input === "string" ? input : JSON.stringify(input, null, 2) }];
}

const ROLE_LABEL: Record<string, string> = { system: "sistema", user: "recebeu", assistant: "ele", tool: "ferramenta", entrada: "entrada" };

function LastRun({ part, run, reason, loading }: { part: "input" | "output"; run: any; reason: string | null; loading: boolean }) {
  if (loading && !run) return <p className="muted st-note">Buscando o último trabalho…</p>;
  if (!run) return part === "input" ? <p className="muted st-note">{reason}</p> : null;
  if (run.content_purged) return part === "input" ? <p className="muted st-note">O texto do último trabalho já foi apagado (privacidade). Só fica a métrica.</p> : null;
  if (part === "input") {
    const msgs = messagesOf(run.input);
    return (
      <div className="st-run">
        <h5>Último trabalho nas suas conversas · {ago(run.started_at)}</h5>
        {msgs.map((m, i) => (
          <div key={i} className={`st-msg-b r-${m.role}`}>
            <small>{ROLE_LABEL[m.role] ?? m.role}</small>
            <pre>{m.text}</pre>
          </div>
        ))}
        {run.input?.tools?.length ? <small className="muted">Com {run.input.tools.length} ferramentas na mão.</small> : null}
      </div>
    );
  }
  const out = run.output;
  const text = typeof out === "string" ? out : out?.content || (out?.tool_calls ? out.tool_calls.map((c: any) => `${c.function?.name ?? c.name}(${c.function?.arguments ?? JSON.stringify(c.arguments ?? "")})`).join("\n") : out == null ? run.error ?? "" : JSON.stringify(out, null, 2));
  return (
    <div className="st-run">
      <h5>O que ele devolveu</h5>
      <div className={`st-msg-b r-assistant ${run.status === "error" ? "err" : ""}`}>
        <pre>{text || "(sem texto: só chamou ferramentas)"}</pre>
      </div>
      <small className="muted">
        {[shortModel(run.model), run.tokens_in || run.tokens_out ? `${run.tokens_in} → ${run.tokens_out} tokens` : "", Number(run.cost_usd) ? `US$ ${Number(run.cost_usd).toFixed(4)}` : "", run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)} s` : ""]
          .filter(Boolean)
          .join(" · ")}
      </small>
      <Link className="btn btn-sm" to={`/executions/${run.execution_id}`}>Abrir em Execuções</Link>
    </div>
  );
}
