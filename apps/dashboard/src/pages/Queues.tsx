import { useState } from "react";
import { ago, api } from "../api";
import { Empty, ErrorBox, Loading, PageHead } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";

interface Queue {
  name: string;
  label: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  avgSeconds: number | null;
  waitSeconds: number | null;
}
interface Overview {
  queues: Queue[];
  failed: { id: string; name: string; label: string; retry_count: number; created_on: string; error: string }[];
  concurrency: number;
}

const sec = (s: number | null) => (s == null ? "–" : s < 60 ? `${s.toLocaleString("pt-BR")}s` : `${Math.round(s / 60)}min`);

/** Filas de execução (como o modo fila do n8n): cada mensagem vira um job, os workers pegam em paralelo e o que falha pode ser reprocessado. */
export function QueuesPage() {
  const { data, error, reload } = useApi<Overview>("/api/queues", { poll: 5000 });
  const [busy, setBusy] = useState<string | null>(null);
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;
  const retry = async (name: string, id: string) => {
    setBusy(id);
    try {
      await api(`/api/queues/${encodeURIComponent(name)}/${id}/retry`, { method: "POST" });
      await reload();
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="page page-wide">
      <PageHead
        title="Filas"
        subtitle={`Cada mensagem entra numa fila e os workers processam ${data.concurrency} por vez em cada réplica. Para aguentar mais gente, suba mais réplicas do worker ou aumente WORKER_CONCURRENCY.`}
      />
      <div className="queue-grid">
        {data.queues.map((q) => (
          <div key={q.name} className="card queue-card">
            <h3>{q.label}</h3>
            <div className="muted mono" style={{ fontSize: 11 }}>{q.name}</div>
            <div className="queue-nums">
              <div><strong>{q.waiting}</strong><small>na fila</small></div>
              <div className={q.active ? "live" : ""}><strong>{q.active}</strong><small>rodando</small></div>
              <div><strong>{q.completed}</strong><small>feitos 24h</small></div>
              <div><strong style={{ color: q.failed ? "var(--err)" : undefined }}>{q.failed}</strong><small>falhas</small></div>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              leva {sec(q.avgSeconds)} · espera {sec(q.waitSeconds)}
            </div>
          </div>
        ))}
      </div>
      <h3>Falhas nas últimas 24h</h3>
      <div className="card">
        {data.failed.map((f) => (
          <div key={f.id} className="line-item" style={{ padding: "12px 16px", alignItems: "flex-start" }}>
            <Icon name="x" size={16} style={{ color: "var(--err)", marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>{f.label}</strong> <span className="muted">· {ago(f.created_on)} · {f.retry_count} tentativa(s)</span>
              <div className="muted mono ellipsis" style={{ fontSize: 11 }}>{f.error || "sem detalhe"}</div>
            </div>
            <button className="btn btn-sm" disabled={busy === f.id} onClick={() => retry(f.name, f.id)}>
              <Icon name="refresh" size={14} /> Reprocessar
            </button>
          </div>
        ))}
        {!data.failed.length && <Empty>Nenhuma falha.</Empty>}
      </div>
    </div>
  );
}
