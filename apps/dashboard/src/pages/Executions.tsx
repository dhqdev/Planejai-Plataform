import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ms, usd, when } from "../api";
import { AGENT_ICON, AGENT_LABEL, ErrorBox, Json, Loading, PageHead, Status } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";

const TRIGGER_LABEL: Record<string, string> = { message: "Mensagem", reminder: "Lembrete", playground: "Teste", watch: "Acompanhamento", improve: "Melhoria diária" };
const TRIGGER_ICON: Record<string, string> = { message: "send", reminder: "bell", playground: "play", watch: "eye", improve: "sparkle" };

export function ExecutionsPage() {
  const [status, setStatus] = useState("");
  const [trigger, setTrigger] = useState("");
  const [params] = useSearchParams();
  const conversation = params.get("conversation");
  const qs = new URLSearchParams({ limit: "100", ...(status ? { status } : {}), ...(trigger ? { trigger } : {}), ...(conversation ? { conversation } : {}) });
  const { data, error, reload } = useApi<any[]>(`/api/executions?${qs}`, { poll: 5000 });
  const nav = useNavigate();

  return (
    <div className="page">
      <PageHead
        title="Execuções"
        subtitle="Cada mensagem processada pelo time de agentes, com todos os passos"
        actions={
          <>
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Todos os status</option>
              <option value="success">Sucesso</option>
              <option value="error">Erro</option>
              <option value="running">Rodando</option>
            </select>
            <select className="select" value={trigger} onChange={(e) => setTrigger(e.target.value)}>
              <option value="">Todos os gatilhos</option>
              <option value="message">Mensagem</option>
              <option value="reminder">Lembrete</option>
              <option value="watch">Acompanhamento</option>
              <option value="improve">Melhoria diária</option>
            </select>
            <button
              className="btn"
              onClick={async () => {
                if (!confirm("Apagar execuções com mais de 30 dias?")) return;
                await api("/api/executions?older_than_days=30", { method: "DELETE" });
                void reload();
              }}
            >
              Limpar antigas
            </button>
          </>
        }
      />
      <ErrorBox error={error} />
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Gatilho</th>
              <th>Entrada</th>
              <th>Agentes</th>
              <th>Pessoa</th>
              <th>Início</th>
              <th>Duração</th>
              <th>Custo</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((e) => (
              <tr key={e.id} className="clickable" onClick={() => nav(`/executions/${e.id}`)}>
                <td><Status status={e.status} /></td>
                <td>{TRIGGER_LABEL[e.trigger] ?? e.trigger}</td>
                <td className="ellipsis" title={e.input ?? ""}>{e.content_purged ? <span className="muted">texto apagado (privacidade)</span> : e.input}</td>
                <td className="muted">{(e.agents ?? []).map((a: string) => AGENT_LABEL[a] ?? a.replace(/^c_/, "")).join(", ")}</td>
                <td>{e.user_name ?? e.phone}</td>
                <td className="muted">{when(e.started_at)}</td>
                <td>{ms(e.duration_ms)}</td>
                <td>{usd(e.cost_usd)}</td>
              </tr>
            ))}
            {data && !data.length && (
              <tr><td colSpan={8} className="empty">Nenhuma execução encontrada</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface Step {
  id: number;
  parent_id: number | null;
  agent: string;
  type: string;
  name: string;
  model: string | null;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  duration_ms: number | null;
  started_at: string;
}

const TYPE_ICON: Record<string, string> = { llm: "sparkle", tool: "settings", delegate: "arrow", channel: "send", info: "circle" };

export function ExecutionDetailPage() {
  const { id } = useParams();
  const { data, error } = useApi<any>(`/api/executions/${id}`, { poll: 3000 });
  const [selected, setSelected] = useState<number | null>(null);

  const steps: Step[] = data?.steps ?? [];
  const depth = useMemo(() => {
    const byId = new Map(steps.map((s) => [s.id, s]));
    const d = new Map<number, number>();
    for (const s of steps) {
      let n = 0;
      let p = s.parent_id;
      while (p && n < 5) {
        n++;
        p = byId.get(p)?.parent_id ?? null;
      }
      d.set(s.id, n);
    }
    return d;
  }, [steps]);

  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;
  const current = steps.find((s) => s.id === selected) ?? null;

  return (
    <div className="page-wide">
      <PageHead
        title={`Execução ${TRIGGER_LABEL[data.trigger] ?? data.trigger}`}
        subtitle={`${data.user_name ?? data.phone ?? ""} · ${when(data.started_at)} · ${ms(data.duration_ms)} · ${data.tokens_in + data.tokens_out} tokens · ${usd(data.cost_usd)}`}
        actions={
          <>
            <Status status={data.status} />
            <Link className="btn" to="/executions">Voltar</Link>
          </>
        }
      />

      <FlowCanvas data={data} steps={steps} onSelect={setSelected} selected={current} />

      {data.error && <div className="error-box" style={{ margin: "14px 0" }}>{data.error}</div>}

      <div className="exec-layout" style={{ marginTop: 14 }}>
        <div className="card steps">
          <div className="step" onClick={() => setSelected(null)} style={{ background: selected == null ? "var(--accent-soft)" : undefined }}>
            <div>
              <div className="step-name">Entrada e saída</div>
              <div className="step-meta">O que chegou e o que foi respondido</div>
            </div>
          </div>
          {steps.map((s) => (
            <div key={s.id} className={`step ${selected === s.id ? "selected" : ""}`} style={{ paddingLeft: 12 + (depth.get(s.id) ?? 0) * 18 }} onClick={() => setSelected(s.id)}>
              <span className={`dot ${s.status === "success" ? "dot-ok" : s.status === "error" ? "dot-err" : "dot-warn"}`} style={{ marginTop: 6 }} />
              <div style={{ minWidth: 0 }}>
                <div className="step-name">
                  <Icon name={TYPE_ICON[s.type] ?? "circle"} size={13} /> {s.name}
                </div>
                <div className="step-meta">
                  {AGENT_LABEL[s.agent] ?? s.agent.replace(/^c_/, "")} · {ms(s.duration_ms)}
                  {s.model ? ` · ${s.model}` : ""}
                  {Number(s.cost_usd) > 0 ? ` · ${usd(s.cost_usd)}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="card card-pad">
          {current ? (
            <>
              <div className="row" style={{ marginBottom: 10 }}>
                <strong>{current.name}</strong>
                <Status status={current.status} />
                <span className="badge">{current.type}</span>
                {current.model && <span className="badge badge-info">{current.model}</span>}
                <span className="spacer" />
                <span className="muted mono">
                  {current.tokens_in}→{current.tokens_out} tokens · {usd(current.cost_usd)}
                </span>
              </div>
              {current.error && <div className="error-box" style={{ marginBottom: 10 }}>{current.error}</div>}
              <div className="io">
                <div>
                  <div className="muted" style={{ marginBottom: 6 }}>ENTRADA</div>
                  <Json value={current.input} />
                </div>
                <div>
                  <div className="muted" style={{ marginBottom: 6 }}>SAÍDA</div>
                  <Json value={current.output} />
                </div>
              </div>
            </>
          ) : (
            <div className="io">
              <div>
                <div className="muted" style={{ marginBottom: 6 }}>MENSAGENS RECEBIDAS</div>
                <Json value={data.input} />
              </div>
              <div>
                <div className="muted" style={{ marginBottom: 6 }}>RESPOSTA DO CTO</div>
                <Json value={data.output} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Desenho da execução no estilo do canvas do n8n: gatilho → CTO → especialistas → resposta.
 * Setas entre especialistas mostram quando um consultou o outro; o número é quantas vezes conversaram.
 */
function FlowCanvas({ data, steps, onSelect, selected }: { data: any; steps: Step[]; onSelect: (id: number | null) => void; selected: Step | null }) {
  const talks = steps.filter((s) => s.type === "delegate");
  const targetOf = (s: Step) => s.name.replace(/^(ask|consult)_/, "");
  const agents: string[] = [];
  for (const t of talks) for (const a of [t.agent, targetOf(t)]) if (a !== "cto" && !agents.includes(a)) agents.push(a);
  const sends = steps.filter((s) => s.type === "channel");
  const ctoLlm = steps.filter((s) => s.agent === "cto" && s.type === "llm");
  const W = 190;
  const H = 64;
  const col = (i: number) => 30 + i * 270;
  const rows = Math.max(1, agents.length);
  const height = Math.max(200, rows * 92 + 50);
  const midY = height / 2 - H / 2;

  const statusOf = (list: Step[]) => (list.some((s) => s.status === "error") ? "err" : list.length && list.every((s) => s.status === "success") ? "ok" : "");
  type N = { key: string; x: number; y: number; icon: string; title: string; sub: string; status: string; step?: Step };
  const nodes: N[] = [
    { key: "trigger", x: col(0), y: midY, icon: TRIGGER_ICON[data.trigger] ?? "play", title: "Gatilho", sub: TRIGGER_LABEL[data.trigger] ?? data.trigger, status: "ok" },
    { key: "cto", x: col(1), y: midY, icon: "brain", title: "CTO", sub: `${ctoLlm.length} chamadas · ${ctoLlm[0]?.model ?? ""}`, status: statusOf(ctoLlm), step: ctoLlm[0] },
    ...agents.map((a, i) => {
      const own = steps.filter((s) => s.agent === a);
      const tools = [...new Set(own.filter((s) => s.type === "tool").map((s) => s.name))];
      const first = talks.find((t) => targetOf(t) === a);
      return {
        key: a,
        x: col(2),
        y: 25 + i * 92 + (rows - agents.length) * 46,
        icon: AGENT_ICON[a] ?? "sparkle",
        title: AGENT_LABEL[a] ?? a.replace(/^c_/, ""),
        sub: tools.join(", ") || "conversou",
        status: statusOf(own),
        step: first,
      };
    }),
    { key: "out", x: col(agents.length ? 3 : 2) + (agents.length ? 60 : 0), y: midY, icon: "send", title: "Resposta", sub: sends.length ? `${sends.length} mensagem(ns)` : data.output === "[[silencio]]" ? "silêncio (só reação)" : "–", status: statusOf(sends), step: sends[0] },
  ];
  const pos = new Map(nodes.map((n) => [n.key, n]));
  const running = data.status === "running";

  // conversas únicas (de -> para) com contagem
  const pairs = new Map<string, { from: string; to: string; n: number; active: boolean }>();
  for (const t of talks) {
    const k = `${t.agent}>${targetOf(t)}`;
    const p = pairs.get(k) ?? { from: t.agent, to: targetOf(t), n: 0, active: false };
    p.n++;
    p.active ||= t.status === "running";
    pairs.set(k, p);
  }

  const curve = (a: string, b: string, active = false, label?: string) => {
    const p = pos.get(a);
    const q = pos.get(b);
    if (!p || !q) return null;
    if (p.x === q.x) {
      // colega -> colega: arco pela direita
      const x = p.x + W;
      const y1 = p.y + H / 2;
      const y2 = q.y + H / 2;
      const bulge = 40 + Math.abs(y2 - y1) * 0.25;
      return (
        <g key={`${a}-${b}`}>
          <path className={`edge peer ${active ? "active" : ""}`} d={`M${x},${y1} C${x + bulge},${y1} ${x + bulge},${y2} ${x},${y2}`} markerEnd="url(#arrow)" />
          {label && <text className="edge-label" x={x + bulge * 0.8} y={(y1 + y2) / 2}>{label}</text>}
        </g>
      );
    }
    const x1 = p.x + W, y1 = p.y + H / 2, x2 = q.x, y2 = q.y + H / 2, dx = (x2 - x1) / 2;
    return (
      <g key={`${a}-${b}`}>
        <path className={`edge ${active ? "active" : ""}`} d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`} />
        {label && <text className="edge-label" x={x1 + dx} y={(y1 + y2) / 2 - 6}>{label}</text>}
      </g>
    );
  };
  const width = (pos.get("out")!.x) + W + 40;

  return (
    <div className="canvas" style={{ height }}>
      <div style={{ position: "relative", width, height }}>
        <svg className="edges" width={width} height={height}>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" />
            </marker>
          </defs>
          {curve("trigger", "cto", running)}
          {[...pairs.values()].map((p) => curve(p.from, p.to, running && p.active, p.n > 1 ? `${p.n}×` : undefined))}
          {curve("cto", "out")}
        </svg>
        {nodes.map((n) => (
          <div
            key={n.key}
            className={`node ${n.status} ${selected && n.step && selected.id === n.step.id ? "selected" : ""}`}
            style={{ left: n.x, top: n.y, width: W }}
            onClick={() => onSelect(n.step?.id ?? null)}
          >
            {n.status && (
              <div className="node-badge" style={{ background: n.status === "ok" ? "var(--ok)" : "var(--err)" }}>
                <Icon name={n.status === "ok" ? "check" : "x"} size={11} />
              </div>
            )}
            <div className="node-title">
              <div className="node-icon"><Icon name={n.icon} size={16} /></div>
              <span>{n.title}</span>
            </div>
            <div className="node-sub ellipsis" style={{ maxWidth: W - 24 }} title={n.sub}>{n.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
