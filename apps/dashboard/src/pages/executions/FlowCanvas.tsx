import { Json, Status } from "../../components";
import { AgentFace } from "../../faces";
import { Icon } from "../../icons";
import { haptic } from "../../touch";
import { NODE_W as W, flowLayout } from "./flow";
import { dur } from "./format";
import { TYPE_ICON, agentMeta, delegateTarget, toolIcon, toolLabel, who } from "./labels";
import { Chips, ErrorText, IO } from "./StepParts";
import type { Step } from "./steps";

/* ---------- Canvas (estilo n8n) ---------- */

/** Canvas com o painel do passo embaixo: tocar num nó mostra a entrada e a saída daquele passo. */
export function CanvasView({ data, steps, clientAgents, selected, onSelect }: { data: any; steps: Step[]; clientAgents: any[]; selected: number | null; onSelect: (id: number | null) => void }) {
  const step = steps.find((s) => s.id === selected) ?? null;
  return (
    <div className="exd-canvas">
      <FlowCanvas data={data} steps={steps} onSelect={onSelect} selected={step} />
      <StepPanel step={step} data={data} clientAgents={clientAgents} />
    </div>
  );
}

function StepPanel({ step, data, clientAgents }: { step: Step | null; data: any; clientAgents: any[] }) {
  if (!step) {
    return (
      <div className="card exd-step">
        <div className="exd-card-head"><Icon name="send" size={14} /><small>Entrada e saída</small><span className="spacer" /><span className="muted exd-hint">toque num nó para ver o passo</span></div>
        <div className="tl-io">
          <div><small>Mensagens recebidas</small><Json value={data.content_purged ? "apagado por privacidade" : data.input} /></div>
          <div><small>Resposta do CTO</small><Json value={data.content_purged ? "apagado por privacidade" : data.output} /></div>
        </div>
      </div>
    );
  }
  const m = agentMeta(step.agent, clientAgents);
  return (
    <div className="card exd-step">
      <div className="exd-card-head">
        <Icon name={step.type === "tool" ? toolIcon(step.name) : TYPE_ICON[step.type] ?? "circle"} size={14} />
        <strong>{step.type === "tool" || step.type === "channel" ? toolLabel(step.name) : step.type === "delegate" ? `${who(m)} chamou ${who(agentMeta(delegateTarget(step.name), clientAgents))}` : step.type === "llm" ? `${who(m)} pensou` : step.name}</strong>
        {step.type !== "delegate" && step.type !== "llm" && <span className="muted">{who(m)}</span>}
        <Status status={step.status} />
        <span className="spacer" />
        <Chips s={step} />
        <span className="tl-time mono">{dur(step.duration_ms)}</span>
      </div>
      {step.error && <ErrorText text={step.error} />}
      <IO step={step} />
    </div>
  );
}

/** Desenha o que o flowLayout calculou: setas em SVG por baixo, nós em HTML por cima. */
function FlowCanvas({ data, steps, onSelect, selected }: { data: any; steps: Step[]; onSelect: (id: number | null) => void; selected: Step | null }) {
  const { nodes, edges, width, height } = flowLayout(data, steps);
  return (
    <div className="canvas exd-flow">
      <div style={{ position: "relative", width, height, margin: "0 auto" }}>
        <svg className="edges" width={width} height={height}>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" />
            </marker>
          </defs>
          {edges.map((e) => (
            <g key={e.key}>
              <path className={`edge ${e.peer ? "peer " : ""}${e.active ? "active" : ""}`} d={e.d} markerEnd={e.peer ? "url(#arrow)" : undefined} />
              {e.label && <text className="edge-label" x={e.lx} y={e.ly}>{e.label}</text>}
            </g>
          ))}
        </svg>
        {nodes.map((n) => (
          <div
            key={n.key}
            className={`node ${n.status} ${selected && n.step && selected.id === n.step.id ? "selected" : ""}`}
            style={{ left: n.x, top: n.y, width: W }}
            onClick={() => { haptic(4); onSelect(n.step?.id ?? null); }}
          >
            {n.status && (
              <div className="node-badge" style={{ background: n.status === "ok" ? "var(--ok)" : "var(--err)" }}>
                <Icon name={n.status === "ok" ? "check" : "x"} size={11} />
              </div>
            )}
            <div className="node-title">
              {n.face !== undefined ? <AgentFace face={n.face} size={30} /> : <div className="node-icon"><Icon name={n.icon} size={16} /></div>}
              <span className="ellipsis" style={{ maxWidth: W - 64 }}>{n.title}</span>
            </div>
            <div className="node-sub ellipsis" style={{ maxWidth: W - 24 }} title={n.sub}>{n.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
