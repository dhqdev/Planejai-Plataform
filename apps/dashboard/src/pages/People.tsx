import { useState } from "react";
import { ago, api, brl, when } from "../api";
import { ErrorBox, Modal, PageHead, Status } from "../components";
import { useApi } from "../hooks";

export function PeoplePage() {
  const { data, error, reload } = useApi<any[]>("/api/people", { poll: 15000 });
  const [adding, setAdding] = useState(false);
  const [detail, setDetail] = useState<any | null>(null);
  const setStatus = async (id: string, status: string) => {
    await api(`/api/people/${id}`, { method: "PATCH", json: { status } });
    void reload();
  };

  return (
    <div className="page">
      <PageHead
        title="Pessoas"
        subtitle="Quem pode falar com o agente. Números novos ficam aguardando sua aprovação."
        actions={<button className="btn btn-primary" onClick={() => setAdding(true)}>+ Adicionar pessoa</button>}
      />
      <ErrorBox error={error} />
      <div className="card">
        <table className="table">
          <thead><tr><th>Pessoa</th><th>WhatsApp</th><th>Status</th><th>Memórias</th><th>Última mensagem</th><th /></tr></thead>
          <tbody>
            {(data ?? []).map((p) => (
              <tr key={p.id}>
                <td><strong>{p.name ?? "–"}</strong></td>
                <td className="mono">+{p.phone}</td>
                <td><Status status={p.status} /></td>
                <td>{p.memories}</td>
                <td className="muted">{ago(p.last_seen_at)}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="btn btn-sm" onClick={() => setDetail(p)}>Detalhes</button>{" "}
                  {p.status !== "active" && <button className="btn btn-sm btn-primary" onClick={() => setStatus(p.id, "active")}>Aprovar</button>}{" "}
                  {p.status !== "blocked" && <button className="btn btn-sm btn-danger" onClick={() => setStatus(p.id, "blocked")}>Bloquear</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && <AddPerson onClose={() => { setAdding(false); void reload(); }} />}
      {detail && <PersonDetail person={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function AddPerson({ onClose }: { onClose: () => void }) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  return (
    <Modal
      title="Adicionar pessoa"
      onClose={onClose}
      footer={<button className="btn btn-primary" onClick={async () => { await api("/api/people", { method: "POST", json: { phone, name } }); onClose(); }}>Adicionar</button>}
    >
      <div className="field"><label>WhatsApp com DDI</label><input className="input" placeholder="5519999999999" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
      <div className="field"><label>Nome</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
    </Modal>
  );
}

function PersonDetail({ person, onClose }: { person: any; onClose: () => void }) {
  const memories = useApi<any[]>(`/api/memories?user=${person.id}`);
  const finance = useApi<any>(`/api/finance?user=${person.id}`);
  const [tz, setTz] = useState(person.timezone ?? "");
  return (
    <Modal title={person.name ?? `+${person.phone}`} onClose={onClose}>
      <div className="field">
        <label>Fuso horário</label>
        <div className="row">
          <input className="input" placeholder="America/Sao_Paulo" value={tz} onChange={(e) => setTz(e.target.value)} />
          <button className="btn" onClick={() => api(`/api/people/${person.id}`, { method: "PATCH", json: { timezone: tz } })}>Salvar</button>
        </div>
      </div>
      <h3>Memórias</h3>
      {(memories.data ?? []).map((m) => (
        <div key={m.id} className="row" style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
          <span style={{ flex: 1 }}>{m.content}</span>
          <button className="btn btn-sm btn-ghost" onClick={async () => { await api(`/api/memories/${m.id}`, { method: "DELETE" }); void memories.reload(); }}>✕</button>
        </div>
      ))}
      {memories.data && !memories.data.length && <p className="muted">Nada guardado ainda.</p>}
      <h3 style={{ marginTop: 16 }}>Gastos do mês</h3>
      {(finance.data?.byCategory ?? []).map((c: any) => (
        <div key={c.category} className="row"><span style={{ flex: 1 }}>{c.category}</span><strong>{brl(c.total)}</strong></div>
      ))}
      <details style={{ marginTop: 8 }}>
        <summary className="muted">Últimos lançamentos</summary>
        {(finance.data?.transactions ?? []).map((t: any) => (
          <div key={t.id} className="row muted" style={{ fontSize: 12 }}>
            <span>{when(t.occurred_at)}</span><span style={{ flex: 1 }}>{t.description ?? t.category}</span>
            <span style={{ color: t.kind === "income" ? "var(--ok)" : undefined }}>{t.kind === "income" ? "+" : "-"}{brl(t.amount)}</span>
          </div>
        ))}
      </details>
    </Modal>
  );
}
