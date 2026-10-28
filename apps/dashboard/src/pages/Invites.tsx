import { useEffect, useState } from "react";
import { api, ago, phoneFmt } from "../api";
import { CopyField, Empty, ErrorBox, Loading, Modal, PageHead } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { UserMascote } from "../mascote/UserMascote";

const STATUS: Record<string, string> = { pending: "Aguardando cadastro", accepted: "Entrou", declined: "Recusou", expired: "Expirado" };

/** Código separado em dois blocos para ler e ditar fácil (K7Q M2X). */
const spaced = (code: string) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);
const expired = (i: { status: string; expires_at: string }) => i.status === "pending" && new Date(i.expires_at) < new Date();
const left = (iso: string) => {
  const h = Math.max(0, (new Date(iso).getTime() - Date.now()) / 3_600_000);
  return h >= 1 ? `vale por mais ${Math.floor(h)}h` : `vale por mais ${Math.max(1, Math.round(h * 60))} min`;
};

interface Personal {
  code: string;
  link: string;
}

/** Texto pronto para o WhatsApp (*negrito*, _itálico_ e ```mono``` para o código ficar fácil de copiar). */
export const inviteText = (p: Personal) =>
  [
    "✨ *Te chamei pro Planejai!*",
    "_Um assistente no WhatsApp que resolve a vida por você_ 💜",
    "",
    "> É só mandar mensagem ou áudio, ele faz o resto:",
    "",
    "💸 *Dinheiro* · anota gastos e mostra pra onde vai",
    "🗓️ *Agenda* · marca compromissos e te lembra na hora",
    "📞 *Por você* · fala com salão, clínica e loja, marca consulta e te conta a resposta",
    "👀 *De olho* · acompanha preço, entrega e o que você pedir",
    "🛒 *Compras* · compara preços antes de você comprar",
    "📍 *Lugares* · acha restaurante, farmácia, o que tiver perto",
    "",
    "👉 *Entra pelo meu link:*",
    p.link,
    "",
    `🔑 Ou toque em _"Tenho um convite"_ e use o código \`\`\`${p.code}\`\`\``,
  ].join("\n");

/**
 * Link de convite pessoal: o mesmo link e código servem para quantas pessoas a pessoa quiser e não vencem.
 * Quem entra por ele aparece em "Quem entrou" na aba Convites. "Trocar link" faz o antigo parar de valer.
 */
export function InviteForm({ onDone }: { onDone?: (link: string) => void }) {
  const [made, setMade] = useState<Personal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [swap, setSwap] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async (fresh = false) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Personal>("/api/invites", { method: "POST", json: fresh ? { fresh: true } : {} });
      setMade(r);
      setSwap(false);
      if (fresh) onDone?.(r.link);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  if (!made) return error ? <ErrorBox error={error} /> : <Loading />;
  return (
    <div className="invite-made">
      <ErrorBox error={error} />
      <span className="invite-code mono" aria-label={`Código ${made.code.split("").join(" ")}`}>
        {spaced(made.code)}
      </span>
      <p className="muted invite-made-note">
        Esse é o seu link. Mande para quantas pessoas quiser: ele não vence, e cada um que entrar aparece na sua aba Convites.
      </p>
      <CopyField value={made.link} />
      <div className="invite-made-actions">
        <a className="btn btn-primary" href={`https://wa.me/?text=${encodeURIComponent(inviteText(made))}`} target="_blank" rel="noreferrer">
          <Icon name="send" size={16} /> Mandar no WhatsApp
        </a>
        {!swap && (
          <button className="btn" onClick={() => setSwap(true)}>
            Trocar link
          </button>
        )}
      </div>
      {swap && (
        <div className="invite-swap">
          <p className="muted">O link e o código de agora param de valer. Quem já entrou continua com você.</p>
          <div className="invite-made-actions">
            <button className="btn" onClick={() => setSwap(false)}>
              Manter
            </button>
            <button className="btn btn-danger" disabled={busy} onClick={() => void load(true)}>
              {busy ? "Trocando…" : "Trocar"}
            </button>
          </div>
        </div>
      )}
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
        subtitle="O Planejai só entra por convite. Cada pessoa tem um link que serve para quantos amigos ela quiser chamar."
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
                <UserMascote name={c.name} outfit={c.outfit} seed={c.id} size={28} />
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
