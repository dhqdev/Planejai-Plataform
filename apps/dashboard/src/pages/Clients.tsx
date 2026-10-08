import { useState } from "react";
import { ago, api, brl, phoneFmt, usd } from "../api";
import { AgentTag, CopyField, Empty, ErrorBox, Loading, Modal, PageHead, Status, confirmDialog, initial } from "../components";
import { AgentFace } from "../faces";
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
              <div className="avatar" aria-hidden="true">{initial(c.full_name || c.name)}</div>
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

function ClientDetail({ client, onClose }: { client: any; onClose: () => void }) {
  const memories = useApi<any[]>(`/api/memories?user=${client.id}`);
  const finance = useApi<any>(`/api/finance?user=${client.id}`);
  const [status, setStatus] = useState(client.status);
  const patch = async (body: any) => {
    const r = await api(`/api/clients/${client.id}`, { method: "PATCH", json: body });
    setStatus(r.status);
  };
  return (
    <Modal title={client.full_name || client.name || (client.phone ? phoneFmt(client.phone) : "Cliente")} icon={<Icon name="user" />} onClose={onClose} wide>
      <dl className="kv">
        <dt>WhatsApp</dt><dd>{client.phone ? phoneFmt(client.phone) : "–"}</dd>
        <dt>E-mail</dt><dd>{client.email ?? "–"}</dd>
        <dt>Convidado por</dt><dd>{client.invited_by_name ?? "–"}</dd>
        <dt>Convites</dt><dd>{client.invites_accepted ?? 0} aceitos de {client.invites_sent ?? 0} enviados · {client.contacts ?? 0} contatos</dd>
        <dt>Última mensagem</dt><dd>{ago(client.last_seen_at)}</dd>
        <dt>Painel</dt>
        <dd>
          {client.account_id ? (
            <span className="row row-wrap" style={{ gap: 8, display: "inline-flex", maxWidth: "100%" }}>
              <span className="grow">{client.account_email}</span> <Status status={client.account_status === "disabled" ? "blocked" : client.account_status} />
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
      <div className="row row-wrap" style={{ margin: "14px 0" }}>
        <Status status={status} />
        <span className="spacer" />
        {status !== "active" && <button className="btn btn-sm btn-primary" onClick={() => patch({ status: "active" })}>Liberar</button>}
        {status !== "blocked" && <button className="btn btn-sm btn-danger" onClick={() => patch({ status: "blocked" })}>Bloquear</button>}
        <button
          className="btn btn-sm btn-danger"
          title="Pedido de exclusão (LGPD): apaga a pessoa e tudo dela"
          onClick={async () => {
            const ok = await confirmDialog({
              title: `Apagar ${client.full_name || client.name || "esta pessoa"}?`,
              body: "Some o cadastro e tudo dela: gastos, limites, lembretes, memórias e contatos. Não tem volta.",
              confirmLabel: "Apagar dados",
              danger: true,
            });
            if (!ok) return;
            await api(`/api/clients/${client.id}`, { method: "DELETE" });
            onClose();
          }}
        >
          Apagar dados
        </button>
      </div>

      <ClientUsage id={client.id} />

      <h3 style={{ marginTop: 16 }}>O que ele sabe</h3>
      {(memories.data ?? []).slice(0, 12).map((m) => (
        <div key={m.id} className="line-item">
          <span className="grow">{m.content}</span>
          <button className="icon-btn" aria-label="Apagar memória" onClick={async () => { await api(`/api/memories/${m.id}`, { method: "DELETE" }); void memories.reload(); }}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
      {memories.data && !memories.data.length && <p className="muted">Nada guardado ainda.</p>}

      <h3 style={{ marginTop: 16 }}>Gastos do mês</h3>
      {(finance.data?.byCategory ?? []).map((c: any) => (
        <div key={c.category} className="line-item"><span className="grow">{c.category}</span><strong className="amount-out nowrap">{brl(c.total)}</strong></div>
      ))}
      {finance.data && !finance.data.byCategory?.length && <p className="muted">Sem gastos no mês.</p>}
    </Modal>
  );
}

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
      <div className="costs-label" style={{ marginTop: 14 }}>Por cliente</div>
      {clients.slice(0, 8).map((c: any) => (
        <button key={c.id} className="costs-row" onClick={() => onOpen(c.id)}>
          <span className="ellipsis costs-name" title={c.name ?? undefined}>{c.name || "Sem nome"}</span>
          <span className="costs-track"><i style={{ width: `${(c.cost / top) * 100}%` }} /></span>
          <span className="costs-val">{usd(c.cost)}</span>
          <span className="costs-sub muted hide-phone">{c.executions} resp. · {usd(c.executions ? c.cost / c.executions : 0)}/resp.</span>
        </button>
      ))}
      {!clients.length && <p className="muted" style={{ fontSize: 13 }}>Ainda sem uso no período.</p>}
    </div>
  );
}

const MODULE_LABEL: Record<string, string> = { convites: "Convites", memorias: "O que ele sabe", meu_time: "Meu time" };

/** Uso do cliente: execuções, custo, agentes que o time criou para ele, o que aprenderam e as abas do app. */
function ClientUsage({ id }: { id: string }) {
  const { data, reload } = useApi<any>(`/api/clients/${id}/usage`);
  if (!data) return null;
  const t = data.totals ?? {};
  const maxMsg = Math.max(1, ...(data.daily ?? []).map((d: any) => d.messages));
  const toggle = async (m: string) => {
    const modules = data.tabs.modules.includes(m) ? data.tabs.modules.filter((x: string) => x !== m) : [...data.tabs.modules, m];
    await api(`/api/clients/${id}/tabs`, { method: "PUT", json: { modules } });
    void reload();
  };
  const removeTab = async (slug: string) => {
    await api(`/api/clients/${id}/tabs`, { method: "PUT", json: { custom: data.tabs.custom.filter((c: any) => c.slug !== slug) } });
    void reload();
  };
  return (
    <>
      <h3>Uso</h3>
      <div className="usage-nums">
        <div><small>Execuções 24h</small><strong>{t.executions_24h ?? 0}</strong></div>
        <div><small>Execuções 7 dias</small><strong>{t.executions_7d ?? 0}</strong></div>
        <div><small>Custo 7 dias</small><strong>{usd(t.cost_7d)}</strong></div>
        <div><small>Custo total</small><strong>{usd(t.cost_total)}</strong></div>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>Mensagens por dia (14 dias){t.errors_7d ? ` · ${t.errors_7d} erro(s) na semana` : ""}</div>
      <div className="usage-bars">
        {(data.daily ?? []).map((d: any) => <i key={d.day} title={`${d.day}: ${d.messages} mensagens, ${usd(d.cost)}`} style={{ height: `${(d.messages / maxMsg) * 100}%` }} />)}
      </div>

      {data.byAgent?.length > 0 && (
        <>
          <h3 style={{ marginTop: 16 }}>Quem trabalhou para ele (7 dias)</h3>
          {data.byAgent.map((a: any) => (
            <div key={a.agent} className="line-item">
              <span className="grow"><AgentTag id={a.agent} /></span>
              <span className="muted" style={{ fontSize: 12, textAlign: "right" }}>{a.calls} chamadas · {Number(a.tokens ?? 0).toLocaleString("pt-BR")} tokens · {usd(a.cost)}</span>
            </div>
          ))}
        </>
      )}

      <h3 style={{ marginTop: 16 }}>Agentes criados para ele</h3>
      {(data.agents ?? []).map((a: any) => (
        <div key={a.id} className="line-item" style={{ opacity: a.active ? 1 : 0.5 }}>
          <span className="face-tile" style={{ width: 40, height: 40 }}><AgentFace face={a.face} size={40} /></span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <strong>{a.persona}</strong> <span className="muted">· {a.name}</span>
            <div className="muted ellipsis" style={{ fontSize: 12 }}>{a.focus} · criado {ago(a.created_at)}</div>
          </span>
          <span className="muted nowrap" style={{ fontSize: 12 }}>{a.uses} {a.uses === 1 ? "uso" : "usos"}</span>
        </div>
      ))}
      {!data.agents?.length && <p className="muted">Nenhum ainda. A reunião das 19h cria quando um assunto se repete.</p>}

      {(data.styleNotes || data.notes?.length > 0) && (
        <>
          <h3 style={{ marginTop: 16 }}>O que o time aprendeu</h3>
          {data.styleNotes && <div className="line-item" style={{ alignItems: "flex-start" }}><span className="persona">Téo</span><span className="grow">{data.styleNotes}</span></div>}
          {(data.notes ?? []).map((n: any) => (
            <div key={n.agent} className="line-item row-wrap" style={{ alignItems: "flex-start" }}><span style={{ width: 150, flexShrink: 0 }}><AgentTag id={n.agent} /></span><span className="grow" style={{ flexBasis: 180 }}>{n.note}</span></div>
          ))}
        </>
      )}

      <h3 style={{ marginTop: 16 }}>Abas do app</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>Início, Agenda, Finanças e De olho sempre aparecem. O resto a reunião noturna libera conforme o uso, ou você liga aqui.</p>
      {Object.keys(MODULE_LABEL).map((m) => (
        <label key={m} className="toggle-row">
          <input type="checkbox" checked={data.tabs.modules.includes(m)} onChange={() => toggle(m)} />
          <span className="grow">{MODULE_LABEL[m]}</span>
        </label>
      ))}
      {(data.tabs.custom ?? []).map((c: any) => (
        <div key={c.slug} className="toggle-row">
          <Icon name={c.icon} size={16} />
          <span className="grow">{c.title} <span className="muted">· aba sob medida</span></span>
          <button className="icon-btn" aria-label={`Remover a aba ${c.title}`} onClick={() => removeTab(c.slug)}><Icon name="x" size={14} /></button>
        </div>
      ))}
      {data.counts && (
        <p className="muted" style={{ fontSize: 12 }}>
          {data.counts.transactions} lançamentos · {data.counts.budgets} limites · {data.counts.reminders} lembretes · {data.counts.watches} acompanhamentos · {data.counts.memories} memórias
        </p>
      )}
    </>
  );
}
