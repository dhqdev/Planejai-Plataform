import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ago } from "../api";
import { Empty, ErrorBox, Loading, Modal, PageHead } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { TeamMap } from "../TeamMap";
import { AgentFace } from "../faces";

/** Time de agentes: mapa, ferramentas de cada um e os agentes que a melhoria diária criou para cada cliente. */
export function AgentsPage() {
  const { data, error } = useApi<any[]>("/api/agents");
  const clients = useApi<any[]>("/api/client-agents");
  const topics = useApi<any[]>("/api/topics");
  const [sel, setSel] = useState<any | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [lastCreated, setLastCreated] = useState<any | null>(null);
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;

  const runNow = async () => {
    setRunning(true);
    setResult(null);
    try {
      const r = await api<any>("/api/improve/run", { method: "POST", json: {} });
      setResult(`Analisou ${r?.users ?? 0} pessoa(s), criou ${r?.created ?? 0} agente(s).`);
      const updated = await clients.reload();
      if (r?.new_agent) {
        setLastCreated(r.new_agent);
      } else if (r?.created > 0 && Array.isArray(updated) && updated.length > 0) {
        setLastCreated(updated[0]);
      }
      topics.reload();
    } catch (e) {
      setResult((e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  const toggle = async (a: any) => {
    await api(`/api/client-agents/${a.id}`, { method: "PATCH", json: { active: !a.active } });
    clients.reload();
  };

  return (
    <div className="page page-wide fit agents-page">
      <PageHead
        actions={
          <>
            <Link className="btn" to="/agents/mapa"><Icon name="resize" size={16} /> Prompts e conversas</Link>
            <Link className="btn" to="/models"><Icon name="cpu" size={16} /> Modelos</Link>
            <button className="btn btn-primary" disabled={running} onClick={runNow}>
              <Icon name="sparkle" size={16} /> {running ? "Reunindo o time…" : "Reunião agora"}
            </button>
          </>
        }
      />
      {result && <div className="notice" style={{ marginBottom: 14 }}>{result}</div>}
      {lastCreated && (
        <div className="card card-pad" style={{ marginBottom: 14, background: "var(--bg-accent, #f3f9f5)", border: "1px solid var(--accent, #2b825b)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="face-tile"><AgentFace face={lastCreated.face} size={50} /></span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent, #2b825b)" }}>Novo especialista criado</div>
              <strong style={{ fontSize: 16 }}>{lastCreated.persona ?? lastCreated.name}</strong>
              <div className="muted" style={{ fontSize: 13 }}>{lastCreated.focus ?? lastCreated.role}</div>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => setSel(lastCreated)}>
              Abrir / Editar
            </button>
          </div>
        </div>
      )}

      <div className="agents-body">
      <div className="card card-pad agents-map" style={{ marginBottom: 14 }}>
        <TeamMap expandTo="/agents/mapa" />
      </div>

      <div className="grid grid-2 agents-lists" style={{ alignItems: "start" }}>
        <div className="card">
          <div className="card-pad agents-card-head"><h3>Time fixo</h3><span className="muted">{data.length}</span></div>
          {data.map((a) => (
            <div key={a.id} className="line-item clickable" style={{ padding: "12px 16px" }} role="button" tabIndex={0} onClick={() => setSel(a)}>
              <span className="face-tile"><AgentFace face={a.face} size={46} agent={a.id} live /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{a.persona ?? a.name}</strong> <span className="muted">· {a.name}</span>
                <div className="muted ellipsis" style={{ fontSize: 12 }}>{a.model}</div>
              </div>
              <span className="muted" style={{ fontSize: 12 }}>{a.tools.length} ferramentas</span>
              <Icon name="chevron-right" size={16} />
            </div>
          ))}
        </div>

        <div className="card">
          <div className="card-pad agents-card-head"><h3>Criados para clientes</h3><span className="muted">{(clients.data ?? []).length}</span></div>
          {(clients.data ?? []).map((a) => (
            <div key={a.id} className="line-item" style={{ padding: "12px 16px", opacity: a.active ? 1 : 0.5 }}>
              <span className="face-tile"><AgentFace face={a.face} size={46} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{a.persona ?? a.name}</strong> <span className="muted">· {a.persona && a.persona !== a.name ? `${a.name} · ` : ""}{a.owner}</span>
                <div className="muted ellipsis" style={{ fontSize: 12 }}>{a.focus} · {a.uses} usos · {(a.tools ?? []).length} ferramentas</div>
              </div>
              <button className="btn btn-sm" onClick={() => toggle(a)}>{a.active ? "Pausar" : "Reativar"}</button>
            </div>
          ))}
          {clients.data && !clients.data.length && <Empty>Ainda nenhum. Quando um assunto aparece em dois dias diferentes, a melhoria das 19h cria um especialista para a pessoa.</Empty>}

        </div>

        <div className="card">
          <div className="card-pad">
            <h3 style={{ marginTop: 0 }}>Assuntos que mais aparecem</h3>
            <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>Os assuntos e as instruções dos agentes de cada cliente ficam só com ele.</p>
            {(topics.data ?? []).slice(0, 12).map((t) => (
              <div key={t.topic} className="line-item">
                <span style={{ flex: 1 }}>{t.topic}</span>
                <span className="muted" style={{ fontSize: 12 }}>{t.days} dia(s) · {ago(t.last_at)}</span>
              </div>
            ))}
            {topics.data && !topics.data.length && <p className="muted" style={{ margin: 0 }}>Aparecem depois da primeira análise das 19h.</p>}
          </div>
        </div>
      </div>
      </div>

      {sel && (
        <Modal title={sel.persona ? `${sel.persona} · ${sel.name}` : sel.name} icon={<AgentFace face={sel.face} size={26} />} onClose={() => setSel(null)} wide>
          <p className="muted" style={{ marginTop: 0 }}>{sel.role}</p>
          <span className="chip">{sel.model}</span>
          {sel.tools.map((t: any) => (
            <div key={t.name} className="line-item">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="mono" style={{ fontSize: 12 }}>{t.name}</div>
                <div className="muted" style={{ fontSize: 12 }}>{t.description}</div>
              </div>
              {t.available ? <Icon name="check" size={16} /> : <Link to="/integrations" className="chip">conectar {t.integration}</Link>}
            </div>
          ))}
        </Modal>
      )}
    </div>
  );
}
