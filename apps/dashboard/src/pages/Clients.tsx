import { useState } from "react";
import { ago, api, brl } from "../api";
import { CopyField, Empty, ErrorBox, Modal, PageHead, Status } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";

/** Super admin: clientes (quem usa o Planejai no WhatsApp), com cadastro completo, convites e acesso ao painel. */
export function ClientsPage() {
  const { data, error, reload } = useApi<any[]>("/api/clients", { poll: 30000 });
  const [adding, setAdding] = useState(false);
  const [detail, setDetail] = useState<any | null>(null);
  const [q, setQ] = useState("");
  const list = (data ?? []).filter((c) => !q || `${c.full_name ?? ""} ${c.name ?? ""} ${c.phone} ${c.email ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const pending = (data ?? []).filter((c) => c.status === "pending" || c.account_status === "pending").length;

  return (
    <div className="page">
      <PageHead
        title="Clientes"
        subtitle={pending ? `${pending} aguardando aprovação` : "Quem usa o Planejai, quem convidou quem e o que o agente aprendeu de cada um"}
        actions={
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <Icon name="user-plus" size={16} /> Novo cliente
          </button>
        }
      />
      <ErrorBox error={error} />
      <div className="field" style={{ maxWidth: 360 }}>
        <input className="input" placeholder="Buscar por nome, telefone ou e-mail" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="card">
        {list.map((c) => (
          <div key={c.id} className="line-item clickable" style={{ padding: "12px 16px" }} onClick={() => setDetail(c)}>
            <div className="avatar">{(c.full_name ?? c.name ?? "?").slice(0, 1).toUpperCase()}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ellipsis">
                <strong>{c.full_name ?? c.name ?? "Sem nome"}</strong>
              </div>
              <div className="muted ellipsis" style={{ fontSize: 12 }}>
                +{c.phone}
                {c.email && ` · ${c.email}`}
                {c.invited_by_name && ` · convidado por ${c.invited_by_name}`}
              </div>
            </div>
            <span className="muted hide-phone" style={{ fontSize: 12, width: 110, textAlign: "right" }}>
              {c.invites_accepted}/{c.invites_sent} convites
            </span>
            <Status status={c.status} />
            <Icon name="chevron-right" size={16} />
          </div>
        ))}
        {data && !list.length && <Empty>Nenhum cliente encontrado.</Empty>}
      </div>
      {adding && <NewClient onClose={() => { setAdding(false); void reload(); }} />}
      {detail && <ClientDetail client={detail} onClose={() => { setDetail(null); void reload(); }} />}
    </div>
  );
}

function NewClient({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ full_name: "", email: "", phone: "", notify: true });
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ link?: string; updated?: boolean }>("/api/clients", { method: "POST", json: form });
      if (r.link) setLink(r.link);
      else onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Novo cliente"
      icon={<Icon name="user-plus" />}
      onClose={onClose}
      footer={
        link ? (
          <button className="btn btn-primary" onClick={onClose}>Fechar</button>
        ) : (
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? "Salvando…" : "Cadastrar"}</button>
        )
      }
    >
      {link ? (
        <>
          <p style={{ marginTop: 0 }}>Cliente cadastrado e liberado no WhatsApp. Com este link a pessoa cria a senha do painel:</p>
          <CopyField value={link} />
        </>
      ) : (
        <>
          <ErrorBox error={error} />
          <div className="field"><label>Nome completo</label><input className="input" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Maria da Silva" autoComplete="name" /></div>
          <div className="field"><label>E-mail</label><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="maria@email.com" autoComplete="email" /></div>
          <div className="field"><label>WhatsApp com DDD</label><input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="11 99999-0000" inputMode="tel" /></div>
          <label className="row" style={{ gap: 8, fontSize: 14 }}>
            <input type="checkbox" checked={form.notify} onChange={(e) => setForm({ ...form, notify: e.target.checked })} />
            Mandar boas-vindas no WhatsApp
          </label>
        </>
      )}
    </Modal>
  );
}

function ClientDetail({ client, onClose }: { client: any; onClose: () => void }) {
  const memories = useApi<any[]>(`/api/memories?user=${client.id}`);
  const finance = useApi<any>(`/api/finance?user=${client.id}`);
  const agents = useApi<any[]>("/api/client-agents");
  const mine = (agents.data ?? []).filter((a) => a.user_id === client.id);
  const [status, setStatus] = useState(client.status);
  const patch = async (body: any) => {
    const r = await api(`/api/clients/${client.id}`, { method: "PATCH", json: body });
    setStatus(r.status);
  };
  return (
    <Modal title={client.full_name ?? client.name ?? `+${client.phone}`} icon={<Icon name="user" />} onClose={onClose} wide>
      <dl className="kv">
        <dt>WhatsApp</dt><dd>+{client.phone}</dd>
        <dt>E-mail</dt><dd>{client.email ?? "–"}</dd>
        <dt>Convidado por</dt><dd>{client.invited_by_name ?? "–"}</dd>
        <dt>Convites</dt><dd>{client.invites_accepted} aceitos de {client.invites_sent} enviados · {client.contacts} contatos</dd>
        <dt>Última mensagem</dt><dd>{ago(client.last_seen_at)}</dd>
        <dt>Painel</dt>
        <dd>
          {client.account_id ? (
            <span className="row" style={{ gap: 8, display: "inline-flex" }}>
              {client.account_email} <Status status={client.account_status === "disabled" ? "blocked" : client.account_status} />
              {client.account_status === "pending" && (
                <button className="btn btn-sm btn-primary" onClick={() => api(`/api/accounts/${client.account_id}`, { method: "PATCH", json: { status: "active" } }).then(onClose)}>
                  Liberar painel
                </button>
              )}
            </span>
          ) : (
            "ainda não criou senha"
          )}
        </dd>
      </dl>
      <div className="row" style={{ margin: "14px 0" }}>
        <Status status={status} />
        <span className="spacer" />
        {status !== "active" && <button className="btn btn-sm btn-primary" onClick={() => patch({ status: "active" })}>Liberar</button>}
        {status !== "blocked" && <button className="btn btn-sm btn-danger" onClick={() => patch({ status: "blocked" })}>Bloquear</button>}
      </div>

      <h3>Agentes criados para ele</h3>
      {mine.map((a) => (
        <div key={a.id} className="line-item">
          <Icon name="sparkle" size={16} />
          <span style={{ flex: 1 }}><strong>{a.name}</strong> <span className="muted">· {a.focus}</span></span>
          <span className="muted" style={{ fontSize: 12 }}>{a.uses} usos</span>
        </div>
      ))}
      {agents.data && !mine.length && <p className="muted">Nenhum ainda. A melhoria diária cria quando um assunto se repete.</p>}

      <h3 style={{ marginTop: 16 }}>O que ele sabe</h3>
      {(memories.data ?? []).slice(0, 12).map((m) => (
        <div key={m.id} className="line-item">
          <span style={{ flex: 1 }}>{m.content}</span>
          <button className="icon-btn" aria-label="Apagar" onClick={async () => { await api(`/api/memories/${m.id}`, { method: "DELETE" }); void memories.reload(); }}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
      {memories.data && !memories.data.length && <p className="muted">Nada guardado ainda.</p>}

      <h3 style={{ marginTop: 16 }}>Gastos do mês</h3>
      {(finance.data?.byCategory ?? []).map((c: any) => (
        <div key={c.category} className="line-item"><span style={{ flex: 1 }}>{c.category}</span><strong>{brl(c.total)}</strong></div>
      ))}
      {finance.data && !finance.data.byCategory?.length && <p className="muted">Sem gastos no mês.</p>}
    </Modal>
  );
}
