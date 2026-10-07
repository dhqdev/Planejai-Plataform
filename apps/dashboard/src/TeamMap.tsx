import { useState } from "react";
import { useApi } from "./hooks";
import { Modal } from "./components";
import { AgentFace, type Face } from "./faces";

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

/**
 * Mapa do time: o CTO no centro, os especialistas em volta e os agentes criados para cada cliente
 * no anel de fora. As linhas mostram quem o CTO acionou nos últimos 7 dias (mais grossa = mais vezes).
 */
export function TeamMap() {
  const { data } = useApi<Graph>("/api/graph", { poll: 30000 });
  const [open, setOpen] = useState<GraphNode | null>(null);
  if (!data) return <div className="team-map" />;

  const specialists = data.nodes.filter((n) => n.kind === "specialist");
  const clients = data.nodes.filter((n) => n.kind === "client");
  const pos: Record<string, { x: number; y: number }> = { cto: { x: 50, y: 50 } };
  specialists.forEach((n, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / specialists.length;
    pos[n.id] = { x: 50 + 30 * Math.cos(a), y: 50 + 34 * Math.sin(a) };
  });
  clients.forEach((n, i) => {
    const a = -Math.PI / 2 + Math.PI / Math.max(specialists.length, 1) + (i * 2 * Math.PI) / Math.max(clients.length, 1);
    pos[n.id] = { x: 50 + 43 * Math.cos(a), y: 50 + 40 * Math.sin(a) };
  });

  const weight = (id: string) => data.edges.filter((e) => e.to === id || e.from === id).reduce((a, e) => a + e.n, 0);
  const max = Math.max(1, ...data.nodes.map((n) => weight(n.id)));
  const peers = data.edges.filter((e) => e.from !== "cto" && e.to !== "cto" && pos[e.from] && pos[e.to]);

  return (
    <>
      <div className="team-map">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {data.nodes
            .filter((n) => n.id !== "cto")
            .map((n) => {
              const p = pos[n.id]!;
              const w = weight(n.id);
              return (
                <line
                  key={n.id}
                  x1={50}
                  y1={50}
                  x2={p.x}
                  y2={p.y}
                  className={`link ${w ? "hot" : ""} ${data.activity[n.id] ? "flow" : ""}`}
                  style={{ strokeWidth: 1.2 + (w / max) * 2.2, strokeDasharray: n.kind === "client" && !w ? "3 5" : undefined }}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          {peers.map((e) => (
            <line key={`${e.from}-${e.to}`} x1={pos[e.from]!.x} y1={pos[e.from]!.y} x2={pos[e.to]!.x} y2={pos[e.to]!.y} className="link hot" vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
        {data.nodes.map((n) => {
          const p = pos[n.id]!;
          const act = data.activity[n.id] ?? 0;
          return (
            <button key={n.id} className={`agent ${n.kind}`} style={{ left: `${p.x}%`, top: `${p.y}%` }} onClick={() => setOpen(n)}>
              <span className="bubble-ico" style={{ position: "relative" }}>
                <AgentFace face={n.face} size={n.kind === "cto" ? 56 : n.kind === "client" ? 34 : 42} title={n.persona ?? n.name} />
                {act > 0 && <span className="pulse" />}
              </span>
              <span className="agent-name">{n.persona ?? n.name}</span>
              <span className="agent-sub">{[n.persona && n.persona !== n.name ? n.name : "", act ? `${act} chamadas` : n.kind === "client" ? "do cliente" : ""].filter(Boolean).join(" · ")}</span>
            </button>
          );
        })}
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
                <dt>Acionado pelo CTO</dt>
                <dd>{data.edges.filter((e) => e.to === open.id).reduce((a, e) => a + e.n, 0)} vezes</dd>
              </>
            )}
          </dl>
        </Modal>
      )}
    </>
  );
}
