import { useState } from "react";
import { api, phoneFmt, usd } from "../api";
import { CopyField, Empty, ErrorBox, Loading, Modal, PageHead, Status } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { UserMascote } from "../mascote/UserMascote";
import { ClientSheet } from "./ClientSheet";

/** Super admin: clientes (quem usa o Planejai no WhatsApp), com cadastro completo, convites e acesso ao painel. */
export function ClientsPage() {
  const { data, error, reload } = useApi<any[]>("/api/clients", { poll: 30000 });
  const [adding, setAdding] = useState(false);
  const [detail, setDetail] = useState<any | null>(null);
  const [q, setQ] = useState("");
  const list = (data ?? []).filter((c) => !q || `${c.full_name ?? ""} ${c.name ?? ""} ${c.phone} ${c.email ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const me = useApi<{ role: string }>("/api/auth/me");
  const isSuper = me.data?.role === "superadmin";
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
      <CostsCard onOpen={(id) => setDetail((data ?? []).find((c) => c.id === id) ?? null)} />
      <div className="field" style={{ maxWidth: 360 }}>
        <input className="input" type="search" name="q" aria-label="Buscar cliente" placeholder="Buscar por nome, telefone ou e-mail…" autoComplete="off" enterKeyHint="search" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="card">
        {list.map((c) => {
          const name = c.full_name || c.name || "Sem nome";
          // a linha inteira é um botão: abre com toque, Enter ou espaço
          return (
            <div
              key={c.id}
              className="line-item clickable"
              style={{ padding: "12px 16px" }}
              role="button"
              tabIndex={0}
              onClick={() => setDetail(c)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                setDetail(c);
              }}
            >
              <UserMascote name={name} outfit={c.outfit} seed={c.id} size={32} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ellipsis" style={{ maxWidth: "none" }} title={name}>
                  <strong>{name}</strong>
                </div>
                <div className="muted ellipsis" style={{ fontSize: 13, maxWidth: "none" }}>
                  {[c.phone && phoneFmt(c.phone), c.email, c.invited_by_name && `convidado por ${c.invited_by_name}`].filter(Boolean).join(" · ") || "sem contato"}
                </div>
                {/* no celular o status desce para baixo do nome: ao lado ele espremia o nome */}
                <div className="phone-only" style={{ marginTop: 4 }}><Status status={c.status} /></div>
              </div>
              <span className="muted hide-phone nowrap" style={{ fontSize: 12, minWidth: 110, textAlign: "right", flexShrink: 0 }}>
                {c.invites_accepted ?? 0}/{c.invites_sent ?? 0} convites
              </span>
              <span className="hide-phone"><Status status={c.status} /></span>
              <Icon name="chevron-right" size={16} />
            </div>
          );
        })}
        {!data && !error && <Loading />}
        {data && !list.length && (
          <Empty>{q ? `Nenhum cliente para “${q}”. Confira o nome, o telefone ou o e-mail.` : "Nenhum cliente ainda. Cadastre o primeiro em Novo cliente."}</Empty>
        )}
      </div>
      {adding && <NewClient onClose={() => { setAdding(false); void reload(); }} />}
      {detail && <ClientSheet client={detail} isSuper={isSuper} onClose={() => { setDetail(null); void reload(); }} />}
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
          <div className="field"><label htmlFor="nc-name">Nome completo</label><input id="nc-name" name="name" className="input" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Maria da Silva" autoComplete="name" /></div>
          <div className="field"><label htmlFor="nc-email">E-mail</label><input id="nc-email" name="email" className="input" type="email" spellCheck={false} autoCapitalize="none" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="maria@email.com" autoComplete="email" /></div>
          <div className="field"><label htmlFor="nc-phone">WhatsApp com DDD</label><input id="nc-phone" name="tel" className="input" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="11 99999-0000" inputMode="tel" autoComplete="tel-national" /></div>
          <label className="row" style={{ gap: 8, fontSize: 14 }}>
            <input type="checkbox" checked={form.notify} onChange={(e) => setForm({ ...form, notify: e.target.checked })} />
            Mandar boas-vindas no WhatsApp
          </label>
        </>
      )}
    </Modal>
  );
}

const int = (n: unknown) => Math.round(Number(n ?? 0)).toLocaleString("pt-BR");

/** Custo de IA por cliente: total por dia (barras) e ranking de quem mais gasta, para decidir limites e preço. */
function CostsCard({ onOpen }: { onOpen: (id: string) => void }) {
  const [days, setDays] = useState(30);
  const { data } = useApi<any>(`/api/costs?days=${days}`);
  const [hover, setHover] = useState<any | null>(null);
  if (!data) return null;
  // período sem dias ou sem clientes não pode derrubar a tela
  const daily: any[] = data.daily ?? [];
  const clients: any[] = data.clients ?? [];
  const max = Math.max(1e-9, ...daily.map((d: any) => d.cost));
  const top = Math.max(1e-9, ...clients.map((c: any) => c.cost));
  const shown = hover ?? daily[daily.length - 1];
  const fmtDay = (d: string) => d.split("-").reverse().slice(0, 2).join("/");
  // grão = custo real x grãos por US$; tokens por grão varia com o modelo, então mostra a média do período
  const g = data.grains;
  return (
    <div className="card card-pad costs-card">
      <div className="row" style={{ alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div className="costs-label">Custo de IA (US$)</div>
          <div className="costs-total">{usd(data.total)}</div>
          <div className="muted" style={{ fontSize: 13 }}>
            {hover ? `${fmtDay(shown.day)}: ${usd(shown.cost)} · ${shown.executions} ${shown.executions === 1 ? "resposta" : "respostas"}` : `últimos ${days} dias · ${clients.length} ${clients.length === 1 ? "cliente" : "clientes"}`}
          </div>
        </div>
        <div className="seg" role="group" aria-label="Período">
          {[7, 30, 90].map((d) => (
            <button key={d} className={days === d ? "active" : ""} aria-pressed={days === d} onClick={() => setDays(d)}>{d} dias</button>
          ))}
        </div>
      </div>
      <div className="costs-bars" onMouseLeave={() => setHover(null)} aria-label="Custo por dia">
        {daily.map((d: any) => (
          <span key={d.day} className={hover?.day === d.day ? "on" : ""} onMouseEnter={() => setHover(d)} onClick={() => setHover(d)} title={`${fmtDay(d.day)}: ${usd(d.cost)}`}>
            <i style={{ height: `${Math.max(d.cost > 0 ? 3 : 0, (d.cost / max) * 100)}%` }} />
          </span>
        ))}
      </div>
      {daily[0] && <div className="costs-axis muted"><span>{fmtDay(daily[0].day)}</span><span>hoje</span></div>}
      {g && (
        <div className="costs-grain">
          <div>
            <small>1 grão vale</small>
            <strong>{usd(g.usdPerGrain)}</strong>
            <span className="muted">{g.tokensPerGrain ? `≈ ${int(g.tokensPerGrain)} tokens (média real)` : "sem uso no período"}</span>
          </div>
          <div>
            <small>Grãos no período</small>
            <strong>{int(g.total)}</strong>
            <span className="muted">{int(g.tokens)} tokens no OpenRouter</span>
          </div>
        </div>
      )}
      <div className="costs-label" style={{ marginTop: 14 }}>Por cliente</div>
      {clients.slice(0, 8).map((c: any) => (
        <button key={c.id} className="costs-row" onClick={() => onOpen(c.id)}>
          <span className="ellipsis costs-name" title={c.name ?? undefined}>{c.name || "Sem nome"}</span>
          <span className="costs-track"><i style={{ width: `${(c.cost / top) * 100}%` }} /></span>
          <span className="costs-val">{usd(c.cost)}</span>
          <span className="costs-sub muted hide-phone">{int(c.grains ?? 0)} grãos · {int(c.tokens ?? 0)} tokens · {c.executions} resp.</span>
        </button>
      ))}
      {!clients.length && <p className="muted" style={{ fontSize: 13 }}>Ainda sem uso no período.</p>}
    </div>
  );
}
