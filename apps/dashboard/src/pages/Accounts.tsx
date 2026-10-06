import { useState } from "react";
import { ago, api } from "../api";
import { ErrorBox, Modal, PageHead, Status } from "../components";
import { useApi } from "../hooks";

/** Super admin: quem se cadastrou no painel, aprovação e papéis. */
export function AccountsPage() {
  const { data, error, reload } = useApi<any[]>("/api/accounts", { poll: 20000 });
  const [adding, setAdding] = useState(false);
  const patch = async (id: string, body: any) => {
    await api(`/api/accounts/${id}`, { method: "PATCH", json: body });
    void reload();
  };
  return (
    <div className="page">
      <PageHead
        title="Contas do painel"
        subtitle="Quem se cadastra vira admin e vê só os próprios gastos, lembretes, conversas e memórias. Super admin vê e configura tudo."
        actions={<button className="btn btn-primary" onClick={() => setAdding(true)}>+ Nova conta</button>}
      />
      <ErrorBox error={error} />
      <div className="card">
        <table className="table">
          <thead><tr><th>Conta</th><th>WhatsApp</th><th>Papel</th><th>Status</th><th>Último acesso</th><th /></tr></thead>
          <tbody>
            {(data ?? []).map((a) => (
              <tr key={a.id}>
                <td><strong>{a.name ?? "–"}</strong><div className="muted">{a.email}</div></td>
                <td className="mono">{a.phone ? `+${a.phone}` : "–"}</td>
                <td>
                  <select className="select" style={{ width: 140 }} value={a.role} onChange={(e) => patch(a.id, { role: e.target.value })}>
                    <option value="admin">Admin</option>
                    <option value="superadmin">Super admin</option>
                  </select>
                </td>
                <td><Status status={a.status === "disabled" ? "blocked" : a.status} /></td>
                <td className="muted">{ago(a.last_login_at)}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {a.status !== "active" && <button className="btn btn-sm btn-primary" onClick={() => patch(a.id, { status: "active" })}>Aprovar</button>}{" "}
                  {a.status !== "disabled" && <button className="btn btn-sm btn-danger" onClick={() => patch(a.id, { status: "disabled" })}>Desativar</button>}{" "}
                  <button className="btn btn-sm btn-ghost" title="Excluir" onClick={async () => { if (confirm(`Excluir a conta ${a.email}?`)) { await api(`/api/accounts/${a.id}`, { method: "DELETE" }); void reload(); } }}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.length && <div className="empty">Ninguém se cadastrou ainda. A tela de login tem o link "Cadastre-se"; o modo de cadastro fica em Configurações.</div>}
      </div>
      {adding && <NewAccount onClose={() => { setAdding(false); void reload(); }} />}
    </div>
  );
}

function NewAccount({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: "", email: "", password: "", phone: "", role: "admin" });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Nova conta" onClose={onClose} footer={
      <button className="btn btn-primary" onClick={async () => {
        try {
          await api("/api/accounts", { method: "POST", json: f });
          onClose();
        } catch (e) {
          setError((e as Error).message);
        }
      }}>Criar</button>
    }>
      <div className="field"><label>Nome</label><input className="input" value={f.name} onChange={set("name")} /></div>
      <div className="field"><label>E-mail</label><input className="input" type="email" value={f.email} onChange={set("email")} /></div>
      <div className="field"><label>Senha inicial</label><input className="input" type="text" value={f.password} onChange={set("password")} /></div>
      <div className="field"><label>WhatsApp (opcional)</label><input className="input" placeholder="19 99999-9999" value={f.phone} onChange={set("phone")} /><span className="help">Liga a conta à pessoa e libera o número para falar com o assistente.</span></div>
      <div className="field"><label>Papel</label><select className="select" value={f.role} onChange={set("role")}><option value="admin">Admin (só os próprios dados)</option><option value="superadmin">Super admin (tudo)</option></select></div>
      <ErrorBox error={error} />
    </Modal>
  );
}
