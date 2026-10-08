import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ErrorBox, Status } from "../../components";
import { useApi } from "../../hooks";
import { Icon } from "../../icons";
import { haptic } from "../../touch";
import { DetailSide } from "./DetailSide";
import { CanvasView } from "./FlowCanvas";
import { dur, fullWhen, plural, tok, usdBR } from "./format";
import { TRIGGER_ICON, TRIGGER_LABEL, channelOf, executionTitle, shortModel } from "./labels";
import { stepTotals, type Step } from "./steps";
import { Story } from "./Story";

/* ================= Detalhe ================= */

type View = "story" | "canvas";

/** História ou Canvas: a escolha fica guardada no aparelho. */
function useViewChoice() {
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem("pj:exec-view") === "canvas" ? "canvas" : "story";
    } catch {
      return "story";
    }
  });
  const pick = (v: View) => {
    haptic(5);
    setView(v);
    try {
      localStorage.setItem("pj:exec-view", v);
    } catch {
      /* sem armazenamento */
    }
  };
  return [view, pick] as const;
}

export function ExecutionDetailPage() {
  const { id } = useParams();
  const { data, error } = useApi<any>(`/api/executions/${id}`, { poll: 3000 });
  const [view, pick] = useViewChoice();
  const [selected, setSelected] = useState<number | null>(null);
  const nav = useNavigate();

  if (error) return <div className="page"><ErrorBox error={error} /><Link className="btn" to="/executions" style={{ marginTop: 12 }}>Voltar</Link></div>;
  if (!data) return <DetailSkeleton />;

  const steps: Step[] = data.steps ?? [];
  const clientAgents: any[] = data.client_agents ?? [];
  const { llm, actions, models } = stepTotals(steps);
  const channel = channelOf(data);

  return (
    <div className="page exd-page fit">
      <div className="exd-head">
        <button className="icon-btn" aria-label="Voltar" onClick={() => { haptic(5); nav(-1); }}><Icon name="chevron-left" size={18} /></button>
        <div className="exd-title">
          <small>
            <Icon name={TRIGGER_ICON[data.trigger] ?? "play"} size={12} /> {TRIGGER_LABEL[data.trigger] ?? data.trigger}
            {channel ? ` · ${channel}` : ""} · {fullWhen(data.started_at)}
          </small>
          <h1 className={data.content_purged ? "purged" : ""}>{executionTitle(data, 12)}</h1>
        </div>
        <Status status={data.status} />
        <div className="ex-pills exd-toggle" role="tablist" aria-label="Visualização">
          <button role="tab" aria-selected={view === "story"} className={view === "story" ? "active" : ""} onClick={() => pick("story")}><Icon name="list" size={14} /> História</button>
          <button role="tab" aria-selected={view === "canvas"} className={view === "canvas" ? "active" : ""} onClick={() => pick("canvas")}><Icon name="graph" size={14} /> Canvas</button>
        </div>
      </div>

      <div className="card ex-kpis exd-kpis">
        <div><small>Duração</small><strong>{data.status === "running" ? "rodando" : dur(data.duration_ms)}</strong><span>{plural(steps.length, "passo", "passos")}</span></div>
        <div><small>Custo</small><strong>{usdBR(data.cost_usd)}</strong><span>{plural(llm, "chamada de IA", "chamadas de IA")}</span></div>
        <div><small>Tokens</small><strong>{tok(Number(data.tokens_in) + Number(data.tokens_out))}</strong><span className="mono">{tok(data.tokens_in)} entrada · {tok(data.tokens_out)} saída</span></div>
        <div><small>Modelo</small><strong className="exd-model" title={models.join(", ")}>{models[0] ? shortModel(models[0]) : "–"}</strong><span>{models.length > 1 ? `+${models.length - 1} outro${models.length > 2 ? "s" : ""}` : plural(actions, "ação do time", "ações do time")}</span></div>
      </div>

      {view === "story" ? (
        <div className="exd-body">
          <div className="card exd-story">
            <Story data={data} steps={steps} clientAgents={clientAgents} />
          </div>
          <DetailSide data={data} steps={steps} clientAgents={clientAgents} />
        </div>
      ) : (
        <CanvasView data={data} steps={steps} clientAgents={clientAgents} selected={selected} onSelect={setSelected} />
      )}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="page exd-page fit" aria-busy="true" aria-label="Carregando">
      <div className="exd-head"><span className="sk sk-circle" style={{ width: 38, height: 38 }} /><div className="exd-title"><span className="sk sk-sm" style={{ width: 180 }} /><span className="sk" style={{ width: 320, height: 22, marginTop: 8 }} /></div></div>
      <div className="card ex-kpis">{[0, 1, 2, 3].map((i) => <div key={i}><span className="sk sk-sm" style={{ width: 70 }} /><span className="sk" style={{ width: 110, height: 22 }} /></div>)}</div>
      <div className="card exd-story" style={{ padding: 20 }}>{[0, 1, 2, 3, 4].map((i) => <div key={i} className="row" style={{ marginBottom: 18 }}><span className="sk sk-circle" /><span className="sk" style={{ width: `${70 - i * 8}%` }} /></div>)}</div>
    </div>
  );
}
