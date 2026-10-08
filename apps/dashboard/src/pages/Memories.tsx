import { useState } from "react";
import { api, day } from "../api";
import { Empty, ErrorBox, PageHead } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";

export function MemoriesPage() {
  const [q, setQ] = useState("");
  const { data, error, reload } = useApi<any[]>("/api/memories", { poll: 30000 });
  const items = (data ?? []).filter((m) => !q || m.content.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="page">
      <PageHead
        title="O que ele sabe de mim"
        subtitle="Fatos duradouros que o assistente guardou para não perguntar de novo. Apague o que não quiser que ele lembre."
        actions={<input className="input" style={{ width: 240 }} placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />}
      />
      <ErrorBox error={error} />
      <div className="card">
        <table className="table">
          <thead><tr><th>Memória</th><th>Quando</th><th /></tr></thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.id}>
                <td>{m.content}</td>
                <td className="muted" style={{ whiteSpace: "nowrap" }}>{day(m.created_at)}</td>
                <td><button className="btn btn-sm btn-ghost" title="Esquecer" onClick={async () => { await api(`/api/memories/${m.id}`, { method: "DELETE" }); void reload(); }}><Icon name="x" size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !items.length && <Empty>Nada guardado ainda.</Empty>}
      </div>
    </div>
  );
}
