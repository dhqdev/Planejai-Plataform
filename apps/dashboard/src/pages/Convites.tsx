import { useState } from "react";
import { ago, api, brl, phoneFmt } from "../api";
import { Empty, ErrorBox, Loading, Modal, PageHead } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import type { Outfit } from "../mascote/Mascote";
import { UserMascote } from "../mascote/UserMascote";
import { InviteForm } from "./Invites";
import { Vazio } from "../Vazio";
import "../styles/convites.css";

interface Data {
  linked: boolean;
  billing: boolean;
  discount: { friends: number; percent: number; step: number; max: number; next: number | null };
  friends: { id: string; name: string; joinedAt: string; paying: boolean; outfit: Outfit | null }[];
  invites: { id: string; code: string; name: string | null; phone: string | null; status: string; created_at: string; expires_at: string; link: string }[];
  subscription: { plan: string; price: number; value: number } | null;
}

const open = (i: Data["invites"][number]) => i.status === "pending" && new Date(i.expires_at) > new Date();
const spaced = (code: string) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);
const left = (iso: string) => {
  const h = Math.max(0, (new Date(iso).getTime() - Date.now()) / 3_600_000);
  if (h >= 48) return `vale por mais ${Math.floor(h / 24)} dias`;
  return h >= 1 ? `vale por mais ${Math.floor(h)}h` : `vale por mais ${Math.max(1, Math.round(h * 60))} min`;
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Convites de cada pessoa: quem entrou pelo convite dela, quem já assina e quanto isso tira da mensalidade. */
export function ConvitesPage() {
  const { data, error, reload } = useApi<Data>("/api/me/convites");
  const [inviting, setInviting] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;

  const { discount: d, friends, subscription: sub } = data;
  const on = data.billing && d.step > 0;
  const pending = data.invites.filter(open);
  const old = data.invites.filter((i) => !open(i));
  const steps = on ? Math.max(1, Math.ceil(d.max / d.step)) : 0;

  const copy = (i: Data["invites"][number]) => {
    void navigator.clipboard?.writeText(i.link);
    setCopied(i.id);
    setTimeout(() => setCopied((c) => (c === i.id ? null : c)), 1600);
  };
  const cancel = async (id: string) => {
    await api(`/api/invites/${id}`, { method: "DELETE" });
    reload();
  };

  return (
    <div className="page convites">
      <PageHead
        title="Convites"
        subtitle="Quem entrou pelo seu convite e quanto isso já tira da sua mensalidade."
        actions={
          <button className="btn btn-primary" onClick={() => setInviting(true)} disabled={!data.linked}>
            <Icon name="user-plus" size={16} /> Convidar
          </button>
        }
      />

      {!data.linked && <p className="muted">Ligue seu WhatsApp ao perfil para convidar pessoas.</p>}

      <section className="card conv-hero" aria-label="Seu desconto">
        <div className="conv-hero-main">
          <span className="conv-label">Seu desconto</span>
          <p className="conv-big">
            {on ? d.percent : 0}
            <small>%</small>
          </p>
          <p className="conv-lead">
            {!on
              ? "O desconto por indicação ainda não está ligado. Seus convites continuam valendo e entram na conta quando ele ligar."
              : d.percent >= d.max
                ? `Você chegou no desconto máximo, com ${plural(d.friends, "amigo assinando", "amigos assinando")}.`
                : d.percent > 0
                  ? `na mensalidade, com ${plural(d.friends, "amigo assinando", "amigos assinando")}. Mais um e vai para ${d.next}%.`
                  : `Cada amigo que entra pelo seu convite e assina um plano tira ${d.step}% da sua mensalidade, até ${d.max}%.`}
          </p>
          {on && (
            <div className="conv-steps" role="img" aria-label={`${d.percent}% de ${d.max}% de desconto`}>
              {Array.from({ length: steps }, (_, n) => (
                <i key={n} className={(n + 1) * d.step <= d.percent ? "on" : ""} />
              ))}
            </div>
          )}
          {on && (
            <div className="conv-scale muted">
              <span>0%</span>
              <span>{d.max}%</span>
            </div>
          )}
          {on && sub && d.percent > 0 && (
            <p className="conv-price">
              {sub.plan}: <s>{brl(sub.price)}</s> <strong>{brl(sub.value)}</strong> por mês
            </p>
          )}
        </div>
        <dl className="conv-stats">
          <div>
            <dt>Entraram</dt>
            <dd>{friends.length}</dd>
          </div>
          <div>
            <dt>Assinando</dt>
            <dd>{friends.filter((f) => f.paying).length}</dd>
          </div>
          <div>
            <dt>Em aberto</dt>
            <dd>{pending.length}</dd>
          </div>
        </dl>
      </section>

      {!friends.length && !pending.length && !old.length ? (
        <Vazio
          img="convites"
          title="Chame quem você gosta"
          text="Mande um convite para um amigo ou alguém da família. Quem entra ganha o próprio assistente, e vocês podem compartilhar agenda e finanças se quiserem."
          actions={data.linked ? [{ label: "Convidar alguém", icon: "user-plus", onClick: () => setInviting(true) }] : []}
        />
      ) : (
      <div className="conv-cols">
        <section className="card conv-list" aria-label="Quem entrou">
          <header>
            <h3>Quem entrou</h3>
            {on && <span className="muted">Quem assina conta {d.step}% para você</span>}
          </header>
          {friends.length ? (
            <ul>
              {friends.map((f) => (
                <li key={f.id}>
                  <UserMascote name={f.name} outfit={f.outfit} seed={f.id} size={34} />
                  <div className="conv-who">
                    <strong>{f.name}</strong>
                    <span className="muted">Entrou {ago(f.joinedAt)}</span>
                  </div>
                  {f.paying ? (
                    <span className="conv-chip on">{on ? `+${d.step}% para você` : "Assinante"}</span>
                  ) : (
                    <span className="conv-chip">Ainda sem plano</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Ninguém entrou pelo seu convite ainda. Gere um convite e mande para alguém.</Empty>
          )}
        </section>

        <section className="card conv-list" aria-label="Convites em aberto">
          <header>
            <h3>Convites em aberto</h3>
            <span className="muted">Cada um serve para uma pessoa</span>
          </header>
          {pending.length ? (
            <ul>
              {pending.map((i) => (
                <li key={i.id}>
                  <span className="conv-ico">
                    <Icon name="link" size={16} />
                  </span>
                  <div className="conv-who">
                    <strong>{i.name ?? (i.phone ? phoneFmt(i.phone) : "Convite por código")}</strong>
                    <span className="muted">
                      {!i.phone && <span className="invite-chip mono">{spaced(i.code)}</span>}
                      {left(i.expires_at)} · feito {ago(i.created_at)}
                    </span>
                  </div>
                  <button className="icon-btn" title={copied === i.id ? "Copiado" : "Copiar link"} aria-label="Copiar link" onClick={() => copy(i)}>
                    <Icon name={copied === i.id ? "check" : "copy"} size={16} />
                  </button>
                  <button className="icon-btn" title="Cancelar convite" aria-label="Cancelar convite" onClick={() => void cancel(i.id)}>
                    <Icon name="x" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nenhum convite esperando cadastro.</Empty>
          )}
          {old.length > 0 && (
            <details className="conv-old">
              <summary>{plural(old.length, "convite antigo", "convites antigos")}</summary>
              <ul>
                {old.map((i) => (
                  <li key={i.id}>
                    <div className="conv-who">
                      <span>{i.name ?? (i.phone ? phoneFmt(i.phone) : "Convite por código")}</span>
                      <span className="muted">
                        {i.status === "declined" ? "Recusou" : "Expirou"} · {ago(i.created_at)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      </div>
      )}

      {inviting && (
        <Modal title="Convidar alguém" icon={<Icon name="user-plus" />} onClose={() => (setInviting(false), reload())}>
          <InviteForm onDone={() => reload()} />
        </Modal>
      )}
    </div>
  );
}
