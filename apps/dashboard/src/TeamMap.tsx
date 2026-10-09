import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { CLIENT_DOING, ROLE_DOING } from "./agentProps";
import { Modal } from "./components";
import { AgentFace, type Face } from "./faces";
import { useApi } from "./hooks";
import { Icon } from "./icons";
import "./teammap.css";

interface GraphNode {
  id: string;
  name: string;
  icon: string;
  role: string;
  kind: "cto" | "specialist" | "client";
  persona?: string;
  face?: Face;
}
interface Graph {
  nodes: GraphNode[];
  edges: { from: string; to: string; n: number }[];
  activity: Record<string, number>;
}
type Pt = { x: number; y: number };
type View = { x: number; y: number; k: number };
type Msg = { id: number; from: string; to: string };

/**
 * Mapa do time: o Juvenal no centro, os especialistas em volta e os agentes de cada cliente no anel de fora,
 * num quadro que dá para arrastar, dar zoom (roda com Ctrl, pinça ou os botões) e rolar. Cada agente pode ser
 * arrastado para outro lugar (fica salvo neste navegador) e, tocado, responde e mostra o que faz. Recados
 * correm pelas linhas do Juvenal para quem ele chama (mais vezes para quem mais trabalhou nos últimos 7 dias).
 * Com movimento reduzido, nada corre sozinho.
 */

/** Tamanho do "mundo" do mapa (pixels antes do zoom). */
const CX = 500;
const CY = 380;
const SIZE = { cto: 92, specialist: 70, client: 54 } as const;
const MIN_K = 0.35;
const MAX_K = 2.4;
const SAVE_KEY = "pj-team-map";

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function loadSaved(): Record<string, Pt> {
  try {
    return JSON.parse(localStorage.getItem(SAVE_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
function save(p: Record<string, Pt>) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(p));
  } catch {
    /* sem armazenamento: só não lembra */
  }
}

/** Curva suave entre dois agentes (a mesma usada pela linha e pelo recado que corre nela). */
function curve(a: Pt, b: Pt) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const bend = 0.12;
  const c = { x: mx - dy * bend, y: my + dx * bend };
  return { there: `M${a.x} ${a.y} Q${c.x} ${c.y} ${b.x} ${b.y}`, back: `M${b.x} ${b.y} Q${c.x} ${c.y} ${a.x} ${a.y}` };
}

function layout(nodes: GraphNode[]): Record<string, Pt> {
  const specialists = nodes.filter((n) => n.kind === "specialist");
  const clients = nodes.filter((n) => n.kind === "client");
  const pos: Record<string, Pt> = { cto: { x: CX, y: CY } };
  specialists.forEach((n, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / specialists.length;
    pos[n.id] = { x: CX + 270 * Math.cos(a), y: CY + 215 * Math.sin(a) };
  });
  clients.forEach((n, i) => {
    const a = -Math.PI / 2 + Math.PI / Math.max(specialists.length, 1) + (i * 2 * Math.PI) / Math.max(clients.length, 1);
    pos[n.id] = { x: CX + 430 * Math.cos(a), y: CY + 330 * Math.sin(a) };
  });
  return pos;
}

const doingOf = (id: string) => {
  const list = ROLE_DOING[id] ?? CLIENT_DOING;
  return list[Math.floor(Math.random() * list.length)]!;
};

export function TeamMap() {
  const { data } = useApi<Graph>("/api/graph", { poll: 30000 });
  const box = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState<Record<string, Pt>>(loadSaved);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const touched = useRef(false); // a pessoa já mexeu no zoom ou arrastou: não reenquadra sozinho
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [open, setOpen] = useState<GraphNode | null>(null);
  const [says, setSays] = useState<Record<string, { text: string; n: number }>>({});
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [bump, setBump] = useState<Record<string, number>>({});
  const [panning, setPanning] = useState(false);
  const hasData = !!data;

  const nodes = data?.nodes ?? [];
  const ids = nodes.map((n) => n.id).join(",");
  const base = useMemo(() => layout(nodes), [ids]);
  const pos = useMemo(() => {
    const p: Record<string, Pt> = { ...base };
    for (const id of Object.keys(p)) if (saved[id]) p[id] = saved[id]!;
    return p;
  }, [base, saved]);
  const posRef = useRef(pos);
  posRef.current = pos;
  const viewRef = useRef(view);
  viewRef.current = view;

  /** Enquadra todos os agentes no quadro. */
  const fit = useCallback(() => {
    const el = box.current;
    const ids = Object.keys(posRef.current);
    if (!el || !ids.length) return;
    const xs = ids.map((i) => posRef.current[i]!.x);
    const ys = ids.map((i) => posRef.current[i]!.y);
    const x0 = Math.min(...xs) - 80;
    const x1 = Math.max(...xs) + 80;
    const y0 = Math.min(...ys) - 70;
    const y1 = Math.max(...ys) + 120;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const k = clamp(Math.min(w / (x1 - x0), h / (y1 - y0)), MIN_K, 1.3);
    setView({ k, x: w / 2 - k * ((x0 + x1) / 2), y: h / 2 - k * ((y0 + y1) / 2) });
  }, []);

  useEffect(() => {
    if (!data) return;
    if (!touched.current) fit();
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => !touched.current && fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [data, fit]);

  /** Zoom mantendo parado o ponto (x, y) do quadro. */
  const zoomAt = useCallback((factor: number, x: number, y: number) => {
    touched.current = true;
    setView((v) => {
      const k = clamp(v.k * factor, MIN_K, MAX_K);
      const f = k / v.k;
      return { k, x: x - (x - v.x) * f, y: y - (y - v.y) * f };
    });
  }, []);

  // roda do mouse / dois dedos no trackpad: rola o mapa; com Ctrl (ou pinça no trackpad), zoom
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
      else {
        touched.current = true;
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, hasData]);

  // arrastar o fundo move o mapa; dois dedos movem e dão zoom
  const ptrs = useRef(new Map<number, Pt>());
  const panMoved = useRef(false);
  const pinch = useRef<{ d: number; k: number; c: Pt; v: View } | null>(null);
  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest(".tm-node, .tm-ctrl, .tm-info")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!ptrs.current.size) panMoved.current = false;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size === 2) {
      const [a, b] = [...ptrs.current.values()] as [Pt, Pt];
      const r = e.currentTarget.getBoundingClientRect();
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k, c: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top }, v: view };
    }
    setPanning(true);
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const last = ptrs.current.get(e.pointerId);
    if (!last) return;
    if (Math.hypot(e.clientX - last.x, e.clientY - last.y) > 0) panMoved.current = true;
    touched.current = true;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size >= 2 && pinch.current) {
      const [a, b] = [...ptrs.current.values()] as [Pt, Pt];
      const r = e.currentTarget.getBoundingClientRect();
      const p = pinch.current;
      const k = clamp((p.k * Math.hypot(a.x - b.x, a.y - b.y)) / Math.max(p.d, 1), MIN_K, MAX_K);
      const c = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      // o ponto do mundo que estava sob os dedos continua sob os dedos
      const wx = (p.c.x - p.v.x) / p.v.k;
      const wy = (p.c.y - p.v.y) / p.v.k;
      setView({ k, x: c.x - wx * k, y: c.y - wy * k });
    } else {
      setView((v) => ({ ...v, x: v.x + e.clientX - last.x, y: v.y + e.clientY - last.y }));
    }
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    ptrs.current.delete(e.pointerId);
    if (ptrs.current.size < 2) pinch.current = null;
    if (!ptrs.current.size) setPanning(false);
  };

  // arrastar um agente muda o lugar dele (salvo neste navegador)
  const drag = useRef<{ id: string; start: Pt; from: Pt; moved: boolean } | null>(null);
  const nodeDown = (e: RPointerEvent<HTMLButtonElement>, id: string) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id, start: { x: e.clientX, y: e.clientY }, from: posRef.current[id]!, moved: false };
  };
  const nodeMove = (e: RPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.start.x;
    const dy = e.clientY - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    const k = viewRef.current.k;
    setSaved((s) => ({ ...s, [d.id]: { x: d.from.x + dx / k, y: d.from.y + dy / k } }));
  };
  const nodeUp = () => {
    if (drag.current?.moved) setSaved((s) => (save(s), s));
    setTimeout(() => (drag.current = null), 0);
  };

  const sayTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const say = useCallback((id: string, text: string, ms = 2800) => {
    setSays((s) => ({ ...s, [id]: { text, n: (s[id]?.n ?? 0) + 1 } }));
    clearTimeout(sayTimers.current[id]);
    sayTimers.current[id] = setTimeout(() => setSays(({ [id]: _gone, ...rest }) => rest), ms);
  }, []);
  useEffect(() => () => Object.values(sayTimers.current).forEach(clearTimeout), []);

  const byId = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n])), [nodes]);
  const nameOf = (id: string) => byId[id]?.persona ?? byId[id]?.name ?? id;

  const pick = (n: GraphNode) => {
    if (drag.current?.moved) return;
    setSel((s) => (s === n.id ? null : n.id));
    say(n.id, n.id === "cto" ? "Juvenal aqui, regendo o time." : `${nameOf(n.id)} aqui, ${doingOf(n.id)}.`);
    setBump((b) => ({ ...b, [n.id]: (b[n.id] ?? 0) + 1 }));
  };

  // recados correndo pelas linhas: o Juvenal chama alguém (quem mais trabalhou é chamado mais) e às vezes recebe a volta
  const seq = useRef(0);
  useEffect(() => {
    if (!data || reduced()) return;
    const others = data.nodes.filter((n) => n.id !== "cto");
    if (!others.length) return;
    const weights = others.map((n) => 1 + Math.sqrt(data.activity[n.id] ?? 0));
    const total = weights.reduce((a, b) => a + b, 0);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const send = (from: string, to: string) => {
      const id = ++seq.current;
      setMsgs((m) => [...m.slice(-8), { id, from, to }]);
      timers.push(setTimeout(() => {
        setMsgs((m) => m.filter((x) => x.id !== id));
        setBump((b) => ({ ...b, [to]: (b[to] ?? 0) + 1 }));
      }, 1150));
    };
    const tick = () => {
      if (document.hidden) return;
      let r = Math.random() * total;
      const i = Math.max(0, weights.findIndex((w) => (r -= w) < 0));
      const to = others[i]!.id;
      send("cto", to);
      if (Math.random() < 0.55) timers.push(setTimeout(() => send(to, "cto"), 1500));
      if (Math.random() < 0.3) timers.push(setTimeout(() => say(to, doingOf(to), 2400), 1200));
    };
    const t = setInterval(tick, 2300);
    timers.push(setTimeout(tick, 500));
    return () => {
      clearInterval(t);
      timers.forEach(clearTimeout);
    };
  }, [data, say]);

  if (!data) return <div className="team-map" />;

  const weight = (id: string) => data.edges.filter((e) => e.to === id || e.from === id).reduce((a, e) => a + e.n, 0);
  const max = Math.max(1, ...data.nodes.map((n) => weight(n.id)));
  const peers = data.edges.filter((e) => e.from !== "cto" && e.to !== "cto" && pos[e.from] && pos[e.to]);
  const focus = hover ?? sel;
  const linked = (a: string, b: string) => !focus || focus === a || focus === b;
  const selNode = sel ? byId[sel] : null;
  const moved = Object.keys(saved).length > 0;

  const links = [
    ...data.nodes.filter((n) => n.id !== "cto" && pos[n.id]).map((n) => ({ a: "cto", b: n.id, w: weight(n.id), client: n.kind === "client" })),
    ...peers.map((e) => ({ a: e.from, b: e.to, w: e.n, client: false })),
  ];

  return (
    <>
      <div
        ref={box}
        className={`team-map tm ${panning ? "panning" : ""} ${focus ? "focused" : ""}`}
        style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${22 * view.k}px ${22 * view.k}px` }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClick={(e) => !(e.target as Element).closest(".tm-node, .tm-ctrl, .tm-info") && !panMoved.current && setSel(null)}
      >
        <div className="tm-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <svg className="tm-links" width={1} height={1} aria-hidden="true">
            {links.map(({ a, b, w, client }) => (
              <path
                key={`${a}-${b}`}
                d={curve(pos[a]!, pos[b]!).there}
                className={`tm-link ${w ? "hot" : ""} ${client && !w ? "dashed" : ""} ${linked(a, b) ? "" : "dim"} ${focus && linked(a, b) ? "on" : ""}`}
                style={{ strokeWidth: (1.4 + (w / max) * 2.4) / Math.max(view.k, 0.6) }}
              />
            ))}
          </svg>
          {msgs.map((m) =>
            pos[m.from] && pos[m.to] ? (
              <span
                key={m.id}
                className={`tm-msg ${m.from === "cto" ? "out" : "back"}`}
                style={{ offsetPath: `path("${m.from === "cto" ? curve(pos.cto!, pos[m.to]!).there : curve(pos.cto!, pos[m.from]!).back}")` }}
              />
            ) : null,
          )}
          {data.nodes.map((n) => {
            const p = pos[n.id]!;
            const act = data.activity[n.id] ?? 0;
            const s = SIZE[n.kind] ?? SIZE.specialist;
            return (
              <button
                key={n.id}
                className={`tm-node ${n.kind} ${sel === n.id ? "sel" : ""} ${focus && !linked(focus, n.id) && focus !== n.id ? "dim" : ""}`}
                style={{ left: p.x, top: p.y }}
                onPointerDown={(e) => nodeDown(e, n.id)}
                onPointerMove={nodeMove}
                onPointerUp={nodeUp}
                onPointerCancel={nodeUp}
                onClick={() => pick(n)}
                onDoubleClick={() => setOpen(n)}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                aria-label={`${nameOf(n.id)}: ${n.name}`}
              >
                <span className="tm-tile" style={{ width: s + 8, height: s + 8 }}>
                  <AgentFace face={n.face} size={s} title={nameOf(n.id)} agent={n.id} live />
                  {act > 0 && <span className="tm-pulse" />}
                  {bump[n.id] ? <span className="tm-ripple" key={bump[n.id]} /> : null}
                </span>
                <span className="tm-name">{nameOf(n.id)}</span>
                <span className="tm-sub">{[n.persona && n.persona !== n.name ? n.name : "", act ? `${act} chamadas` : n.kind === "client" ? "do cliente" : ""].filter(Boolean).join(" · ")}</span>
                {says[n.id] && (
                  <span className="tm-say" key={says[n.id]!.n}>
                    {says[n.id]!.text}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="tm-ctrl" role="toolbar" aria-label="Zoom do mapa">
          <button className="icon-btn" aria-label="Aproximar" onClick={() => box.current && zoomAt(1.25, box.current.clientWidth / 2, box.current.clientHeight / 2)}>
            <Icon name="plus" size={16} />
          </button>
          <button className="icon-btn" aria-label="Afastar" onClick={() => box.current && zoomAt(0.8, box.current.clientWidth / 2, box.current.clientHeight / 2)}>
            <svg width={16} height={16} viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" /></svg>
          </button>
          <button className="icon-btn" aria-label="Enquadrar todos" onClick={() => { touched.current = false; fit(); }}>
            <Icon name="resize" size={15} />
          </button>
          {moved && (
            <button
              className="icon-btn"
              aria-label="Voltar os agentes para o lugar"
              title="Voltar os agentes para o lugar"
              onClick={() => {
                setSaved({});
                save({});
                touched.current = false;
                setTimeout(fit, 0);
              }}
            >
              <Icon name="refresh" size={15} />
            </button>
          )}
        </div>
        {!selNode && <div className="tm-hint">Arraste o mapa ou um agente. Toque num agente para falar com ele.</div>}

        {selNode && (
          <div className="tm-info" key={selNode.id}>
            <AgentFace face={selNode.face} size={40} agent={selNode.id} live />
            <div>
              <strong>{nameOf(selNode.id)}</strong>
              <small>
                {selNode.name} · {data.activity[selNode.id] ?? 0} chamadas em 7 dias
              </small>
            </div>
            <button className="btn" onClick={() => setOpen(selNode)}>Detalhes</button>
            <button className="icon-btn" aria-label="Fechar" onClick={() => setSel(null)}>
              <Icon name="x" size={15} />
            </button>
          </div>
        )}
      </div>
      {open && (
        <Modal title={open.persona && open.persona !== open.name ? `${open.persona} · ${open.name}` : open.name} icon={<AgentFace face={open.face} size={26} />} onClose={() => setOpen(null)}>
          <p style={{ marginTop: 0 }}>{open.role}</p>
          <dl className="kv">
            <dt>Tipo</dt>
            <dd>{open.kind === "cto" ? "Orquestrador" : open.kind === "client" ? "Criado pela melhoria diária" : "Especialista"}</dd>
            <dt>Chamadas (7 dias)</dt>
            <dd>{data.activity[open.id] ?? 0}</dd>
            {open.id !== "cto" && (
              <>
                <dt>Acionado pelo Juvenal</dt>
                <dd>{data.edges.filter((e) => e.to === open.id).reduce((a, e) => a + e.n, 0)} vezes</dd>
              </>
            )}
          </dl>
        </Modal>
      )}
    </>
  );
}
