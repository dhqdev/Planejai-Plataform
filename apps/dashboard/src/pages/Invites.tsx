import { useState } from "react";
import { api, ago, phoneFmt } from "../api";
import { CopyField, Empty, ErrorBox, Loading, Modal, PageHead } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";

const STATUS: Record<string, string> = { pending: "Aguardando resposta", accepted: "Aceitou", declined: "Recusou", expired: "Expirado" };

/** Formulário de convite: o Planejai manda a mensagem no WhatsApp e a pessoa responde SIM ou NÃO. */
export function InviteForm({ onDone }: { onDone?: (link: string) => void }) {
  const [form, setForm] = useState({ name: "", phone: "", email: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ link: string }>("/api/invites", { method: "POST", json: form });
      setLink(r.link);
      setForm({ name: "", phone: "", email: "" });
      onDone?.(r.link);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (link)
    return (
      <div>
        <p style={{ marginTop: 0 }}>Convite enviado no WhatsApp. Quando a pessoa responder SIM, vocês viram contatos e podem mandar coisas um para o outro.</p>
        <CopyField value={link} />
        <button className="btn btn-sm" style={{ marginTop: 12 }} onClick={() => setLink(null)}>
          Convidar outra pessoa
        </button>
      </div>
    );

  return (
    <div>
      <ErrorBox error={error} />
      <div className="field">
        <label>Nome</label>
        <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Giovani Souza" />
      </div>
      <div className="field">
        <label>WhatsApp com DDD</label>
        <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="11 99999-0000" inputMode="tel" />
      </div>
      <div className="field">
        <label>E-mail (opcional)</label>
        <input className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="giovani@email.com" inputMode="email" />
      </div>
      <button className="btn btn-primary" style={{ width: "100%" }} disabled={busy || form.phone.replace(/\D/g, "").length < 10} onClick={send}>
        <Icon name="send" size={16} /> {busy ? "Enviando…" : "Enviar convite"}
      </button>
    </div>
  );
}

export function InvitesPage({ isSuper }: { isSuper: boolean }) {
  const { data, error, reload } = useApi<any>("/api/invites");
  const contacts = useApi<any[]>(isSuper ? null : "/api/contacts");
  const [open, setOpen] = useState(false);
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  const s = data.stats ?? {};

  return (
    <div className="page">
      <PageHead
        title="Convites"
        subtitle="O Planejai só entra por convite. O convite chega no WhatsApp e a pessoa responde SIM ou NÃO."
        actions={
          <button className="btn btn-primary" onClick={() => setOpen(true)}>
            <Icon name="user-plus" size={16} /> Convidar
          </button>
        }
      />
      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <div className="card card-pad stat"><div className="label">Convidados</div><div className="value">{s.total ?? 0}</div></div>
        <div className="card card-pad stat"><div className="label">Aceitaram</div><div className="value">{s.accepted ?? 0}</div></div>
        <div className="card card-pad stat"><div className="label">Aguardando</div><div className="value">{s.pending ?? 0}</div></div>
        <div className="card card-pad stat"><div className="label">Recusaram</div><div className="value">{s.declined ?? 0}</div></div>
      </div>

      <div className={isSuper ? "grid grid-2" : ""} style={{ alignItems: "start" }}>
        <div className="card">
          <div className="card-pad"><h3 style={{ margin: 0 }}>Enviados</h3></div>
          {data.invites.length ? (
            data.invites.map((i: any) => (
              <div className="line-item" key={i.id} style={{ padding: "10px 16px" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="ellipsis"><strong>{i.name ?? phoneFmt(i.phone)}</strong></div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {phoneFmt(i.phone)} · {STATUS[i.status] ?? i.status} · {ago(i.created_at)}
                    {isSuper && ` · por ${i.inviter_name}`}
                  </div>
                </div>
                {i.status === "pending" && (
                  <>
                    <button className="icon-btn" title="Copiar link" onClick={() => navigator.clipboard?.writeText(i.link)}>
                      <Icon name="link" size={16} />
                    </button>
                    <button
                      className="icon-btn"
                      title="Cancelar convite"
                      onClick={async () => {
                        await api(`/api/invites/${i.id}`, { method: "DELETE" });
                        reload();
                      }}
                    >
                      <Icon name="x" size={16} />
                    </button>
                  </>
                )}
                {i.status === "accepted" && <Icon name="check" size={16} />}
              </div>
            ))
          ) : (
            <Empty>Nenhum convite ainda.</Empty>
          )}
        </div>

        {isSuper ? (
          <div className="card">
            <div className="card-pad"><h3 style={{ margin: 0 }}>Quem mais convida</h3></div>
            {data.leaderboard.length ? (
              data.leaderboard.map((l: any, n: number) => (
                <div className="line-item" key={l.name} style={{ padding: "10px 16px" }}>
                  <span className="muted" style={{ width: 22 }}>{n + 1}</span>
                  <span style={{ flex: 1 }}>{l.name}</span>
                  <span className="muted">{l.total} convites</span>
                  <strong style={{ width: 90, textAlign: "right" }}>{l.accepted} entraram</strong>
                </div>
              ))
            ) : (
              <Empty>Ninguém convidou ainda.</Empty>
            )}
          </div>
        ) : (
          <div className="card" style={{ marginTop: 14 }}>
            <div className="card-pad">
              <h3 style={{ margin: 0 }}>Seus contatos</h3>
              <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>No WhatsApp, diga por exemplo "manda esse look pro Giovani".</p>
            </div>
            {(contacts.data ?? []).map((c) => (
              <div className="line-item" key={c.id} style={{ padding: "10px 16px" }}>
                <Icon name="user" size={16} />
                <span style={{ flex: 1 }}>{c.name}</span>
                <span className="muted">{phoneFmt(c.phone)}</span>
              </div>
            ))}
            {contacts.data && !contacts.data.length && <Empty>Quando alguém aceitar seu convite, aparece aqui.</Empty>}
          </div>
        )}
      </div>

      {open && (
        <Modal title="Convidar alguém" icon={<Icon name="user-plus" />} onClose={() => { setOpen(false); reload(); }}>
          <InviteForm onDone={() => reload()} />
        </Modal>
      )}
    </div>
  );
}
