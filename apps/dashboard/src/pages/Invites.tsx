import { useState } from "react";
import { api, ago, phoneFmt } from "../api";
import { CopyField, Empty, ErrorBox, Loading, Modal, PageHead } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";

const STATUS: Record<string, string> = { pending: "Aguardando cadastro", accepted: "Entrou", declined: "Recusou", expired: "Expirado" };

/** Código separado em dois blocos para ler e ditar fácil (K7Q M2X). */
const spaced = (code: string) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);
const expired = (i: { status: string; expires_at: string }) => i.status === "pending" && new Date(i.expires_at) < new Date();
const left = (iso: string) => {
  const h = Math.max(0, (new Date(iso).getTime() - Date.now()) / 3_600_000);
  return h >= 1 ? `vale por mais ${Math.floor(h)}h` : `vale por mais ${Math.max(1, Math.round(h * 60))} min`;
};

interface Created {
  code: string;
  link: string;
  name: string | null;
  expires_at: string;
}

/** Gera um convite: link e código que valem 24h e servem para um cadastro. Quem convida manda como quiser. */
export function InviteForm({ onDone }: { onDone?: (link: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<Created | null>(null);

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Created>("/api/invites", { method: "POST", json: { name: name.trim() || undefined } });
      setMade(r);
      setName("");
      onDone?.(r.link);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (made) {
    const first = made.name?.split(" ")[0];
    const text = `${first ? `Oi, ${first}! ` : ""}Te convidei para o Planejai, um assistente no WhatsApp que organiza gastos, agenda e lembretes.\n\nEntre por este link: ${made.link}\nOu use o código ${made.code} em "Tenho um convite". Vale por 24 horas.`;
    return (
      <div className="invite-made">
        <span className="invite-code mono" aria-label={`Código ${made.code.split("").join(" ")}`}>
          {spaced(made.code)}
        </span>
        <p className="muted invite-made-note">Vale por 24 horas e serve para um cadastro. A pessoa abre o link ou digita o código em "Tenho um convite".</p>
        <CopyField value={made.link} />
        <div className="invite-made-actions">
          <a className="btn btn-primary" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">
            <Icon name="send" size={16} /> Mandar no WhatsApp
          </a>
          <button className="btn" onClick={() => setMade(null)}>
            Gerar outro
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <ErrorBox error={error} />
      <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>
        O Planejai gera um link e um código para a pessoa entrar. Ela preenche o próprio nome, WhatsApp e senha no cadastro.
      </p>
      <div className="field">
        <label>Para quem é (opcional)</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Giovani Souza" onKeyDown={(e) => e.key === "Enter" && make()} />
        <span className="help">Só para você saber de quem é cada convite e para dar oi pelo nome.</span>
      </div>
      <button className="btn btn-primary" style={{ width: "100%" }} disabled={busy} onClick={make}>
        <Icon name="link" size={16} /> {busy ? "Gerando…" : "Gerar convite"}
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
        subtitle="O Planejai só entra por convite. Cada convite é um link com código que vale 24 horas e serve para uma pessoa."
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
                  <div className="ellipsis">
                    <strong>{i.name ?? (i.phone ? phoneFmt(i.phone) : "Convite por código")}</strong>
                    {!i.phone && i.status === "pending" && !expired(i) && <span className="invite-chip mono">{spaced(i.code)}</span>}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {i.phone ? `${phoneFmt(i.phone)} · ` : ""}
                    {expired(i) ? "Expirado" : STATUS[i.status] ?? i.status}
                    {i.status === "pending" && !expired(i) && !i.phone ? ` · ${left(i.expires_at)}` : ""} · {ago(i.created_at)}
                    {isSuper && ` · por ${i.inviter_name}`}
                  </div>
                </div>
                {i.status === "pending" && !expired(i) && (
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
