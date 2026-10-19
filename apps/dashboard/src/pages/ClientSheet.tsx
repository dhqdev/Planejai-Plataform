import { useState } from "react";
import { ago, api, brl, phoneFmt, usd } from "../api";
import { AgentTag, Modal, Status, alertDialog, confirmDialog } from "../components";
import { AgentFace, CORE_FACES } from "../faces";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { UserMascote } from "../mascote/UserMascote";
import "../styles/pessoas.css";

/**
 * Ficha do cliente em Pessoas (super admin): resumo, uso por dia, plano e grãos, e o perfil com o que ele usa no app.
 * No notebook abre do botão como as outras janelas; no celular vira folha com as abas presas no topo.
 */

type Tab = "resumo" | "uso" | "plano" | "perfil";
const TABS: [Tab, string][] = [["resumo", "Resumo"], ["uso", "Uso"], ["plano", "Plano"], ["perfil", "Perfil"]];

const nf = new Intl.NumberFormat("pt-BR");
const int = (n: unknown) => nf.format(Math.round(Number(n ?? 0)));
const grains = (n: unknown) => `${int(n)} ${Math.round(Number(n ?? 0)) === 1 ? "grão" : "grãos"}`;
/** AAAA-MM-DD é dia de calendário: formata sem passar pelo fuso. */
const ymd = (s: string | null | undefined, year = false) => {
  if (!s) return "–";
  const [y, m, d] = String(s).slice(0, 10).split("-");
  return year ? `${d}/${m}/${y}` : `${d}/${m}`;
};
const dateBR = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }) : "–");
const weekday = (s: string) => new Date(`${s}T12:00:00`).toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
const daysUntil = (s: string | null | undefined) => (s ? Math.round((new Date(`${s}T12:00:00`).getTime() - Date.now()) / 86_400_000) : null);
const inDays = (n: number | null) => (n == null ? "" : n === 0 ? "hoje" : n === 1 ? "amanhã" : n > 1 ? `em ${n} dias` : n === -1 ? "venceu ontem" : `venceu há ${-n} dias`);
const duration = (ms: number | null) => (ms == null ? "–" : ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${(ms / 60_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} min`);

const STATE: Record<string, { label: string; tone: string; hint: string }> = {
  off: { label: "Cobrança desligada", tone: "", hint: "Ninguém gasta grãos enquanto a cobrança estiver desligada em Configurações." },
  exempt: { label: "Liberado", tone: "badge-info", hint: "Usa sem gastar grãos (dono ou liberado por você)." },
  plan: { label: "Plano pago", tone: "badge-ok", hint: "Assinatura em dia no Asaas." },
  overdue: { label: "Pagamento atrasado", tone: "badge-err", hint: "A mensalidade venceu e ainda não foi paga." },
  trial: { label: "Período livre", tone: "badge-info", hint: "Usa sem gastar grãos até o fim do período livre." },
  free: { label: "Grãos grátis", tone: "badge-warn", hint: "Sem plano: usa os grãos de boas-vindas e pacotes avulsos." },
  empty: { label: "Sem grãos", tone: "badge-err", hint: "Zerou os grãos: o assistente parou até ele assinar ou comprar um pacote." },
};
const METHOD: Record<string, string> = { CREDIT_CARD: "Cartão", PIX: "Pix", BOLETO: "Boleto", UNDEFINED: "Pix, cartão ou boleto", card: "Cartão", pix: "Pix", boleto: "Boleto" };
const CHANNEL: Record<string, string> = { baileys: "WhatsApp", whatsapp: "WhatsApp", evolution: "WhatsApp", cloud: "WhatsApp", telegram: "Telegram", app: "Chat do app", playground: "Teste" };

export function ClientSheet({ client, onClose, isSuper }: { client: any; onClose: () => void; isSuper?: boolean }) {
  const [tab, setTab] = useState<Tab>("resumo");
  const [days, setDays] = useState(14);
  const usage = useApi<any>(`/api/clients/${client.id}/usage?days=${days}`);
  const [status, setStatus] = useState(client.status);
  const name = client.full_name || client.name || (client.phone ? phoneFmt(client.phone) : "Cliente");
  const data = usage.data;
  const billing = data?.billing;
  const state = billing ? STATE[billing.state] : null;

  return (
    <Modal title={name} icon={<UserMascote name={client.full_name || client.name} outfit={client.outfit} seed={client.id} size={26} />} onClose={onClose} wide className="cs-modal drop-center">
      <div className="cs-top">
        <div className="cs-id">
          <span className="cs-sub">{[client.phone && phoneFmt(client.phone), client.email].filter(Boolean).join(" · ") || "sem contato"}</span>
          <div className="cs-chips">
            <Status status={status} />
            {state && <span className={`badge ${state.tone}`}>{billing.subscription?.active && billing.subscription.plan ? `Plano ${billing.subscription.plan.name}` : state.label}</span>}
            <span className="cs-chip-muted">última mensagem {ago(client.last_seen_at)}</span>
          </div>
        </div>
        <div className="seg cs-tabs" role="tablist" aria-label="Ficha do cliente">
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
      </div>

      {!data ? (
        <div className="cs-loading" aria-busy="true">{usage.error ?? "Carregando a ficha…"}</div>
      ) : tab === "resumo" ? (
        <Resumo client={client} data={data} isSuper={isSuper} onClose={onClose} go={setTab} />
      ) : tab === "uso" ? (
        <Uso data={data} days={days} setDays={setDays} />
      ) : tab === "plano" ? (
        <Plano id={client.id} name={name} data={data} reload={usage.reload} />
      ) : (
        <Perfil client={client} data={data} status={status} setStatus={setStatus} reload={usage.reload} onClose={onClose} />
      )}
    </Modal>
  );
}

/* ---------------- Resumo ---------------- */

function Resumo({ client, data, isSuper, onClose, go }: { client: any; data: any; isSuper?: boolean; onClose: () => void; go: (t: Tab) => void }) {
  const b = data.billing;
  const a = data.activity ?? {};
  const daily: any[] = data.daily ?? [];
  const today = daily[daily.length - 1] ?? { grains: 0, messages: 0, cost: 0 };
  const sub = b?.subscription;
  const due = sub?.active ? daysUntil(sub.nextDueDate) : null;
  const channels = (a.channels ?? []).map((c: string) => CHANNEL[c] ?? c).filter((c: string, i: number, all: string[]) => all.indexOf(c) === i);
  return (
    <div className="cs-pane">
      <div className="cs-kpis">
        <button className="cs-kpi" onClick={() => go("plano")}>
          <small>Saldo de grãos</small>
          <strong>{b?.state === "exempt" || b?.state === "off" ? "Livre" : int(b?.wallet.total)}</strong>
          <span>{b?.state === "exempt" || b?.state === "off" ? "não gasta grãos" : b?.daysLeft != null ? `dura uns ${b.daysLeft} dias no ritmo atual` : `plano ${int(b?.wallet.plan)} · extra ${int(b?.wallet.extra)}`}</span>
        </button>
        <button className="cs-kpi" onClick={() => go("uso")}>
          <small>Hoje</small>
          <strong>{grains(today.grains)}</strong>
          <span>{int(today.messages)} {today.messages === 1 ? "mensagem" : "mensagens"} · {usd(today.cost)}</span>
        </button>
        <button className="cs-kpi" onClick={() => go("uso")}>
          <small>Últimos 30 dias</small>
          <strong>{int(a.messages30)} msg</strong>
          <span>ativo em {a.activeDays30 ?? 0} de 30 dias</span>
        </button>
        <button className="cs-kpi" onClick={() => go("plano")}>
          <small>Próximo pagamento</small>
          <strong>{sub?.active && sub.nextDueDate ? ymd(sub.nextDueDate) : "Sem plano"}</strong>
          <span>{sub?.active ? `${brl(sub.value)} · ${inDays(due)}` : STATE[b?.state]?.label ?? "–"}</span>
        </button>
      </div>

      <section className="cs-card">
        <div className="cs-card-head">
          <h4>Grãos por dia</h4>
          <span className="muted">últimos {daily.length} dias</span>
        </div>
        <Bars daily={daily} metric="grains" compact />
      </section>

      <section className="cs-card">
        <h4>Como ele usa</h4>
        <dl className="cs-kv">
          <dt>Cliente desde</dt><dd>{dateBR(a.since ?? client.created_at)}</dd>
          <dt>Primeira conversa</dt><dd>{a.firstDay ? ymd(a.firstDay, true) : "ainda não conversou"}</dd>
          <dt>Última mensagem</dt><dd>{ago(a.lastSeenAt ?? client.last_seen_at)}</dd>
          <dt>Horário que mais usa</dt><dd>{a.peakHour != null ? `por volta das ${a.peakHour}h` : "sem dados na semana"}</dd>
          <dt>Tempo de resposta</dt><dd>{a.avgResponseMs != null ? `${duration(a.avgResponseMs)} em média (7 dias)` : "–"}</dd>
          <dt>Fala por</dt><dd>{channels.length ? channels.join(", ") : "–"}</dd>
          <dt>Total</dt><dd>{int(a.messagesTotal)} mensagens · {int(a.executionsTotal)} respostas</dd>
          <dt>Painel</dt>
          <dd>
            {client.account_id
              ? `${a.panelLastAt ? `entrou ${ago(a.panelLastAt)}` : "nunca entrou"}${a.panelDevices ? ` · ${a.panelDevices} ${a.panelDevices === 1 ? "aparelho" : "aparelhos"}` : ""}`
              : "ainda não criou senha"}
          </dd>
          <dt>Avisos no celular</dt><dd>{a.pushDevices ? `ligados em ${a.pushDevices} ${a.pushDevices === 1 ? "aparelho" : "aparelhos"}` : "desligados"}</dd>
        </dl>
      </section>

      {a.byHour?.some((n: number) => n > 0) && (
        <section className="cs-card">
          <div className="cs-card-head"><h4>Horários (7 dias)</h4><span className="muted">respostas por hora</span></div>
          <div className="cs-hours" aria-label="Respostas por hora do dia">
            {a.byHour.map((n: number, h: number) => (
              <i key={h} title={`${h}h: ${n}`} style={{ height: `${(n / Math.max(1, ...a.byHour)) * 100}%` }} className={h === a.peakHour ? "on" : ""} />
            ))}
          </div>
          <div className="cs-axis muted"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
        </section>
      )}

      {(isSuper && client.account_id && client.account_status === "active") || client.account_status === "pending" ? (
        <div className="cs-actions">
          {client.account_status === "pending" && (
            <button className="btn btn-primary" onClick={() => api(`/api/accounts/${client.account_id}`, { method: "PATCH", json: { status: "active" } }).then(onClose)}>Liberar painel</button>
          )}
          {isSuper && client.account_id && client.account_status === "active" && (
            <button
              className="btn"
              title="Entrar no painel como este cliente"
              onClick={async () => {
                await api(`/api/clients/${client.id}/impersonate`, { method: "POST" });
                window.location.reload();
              }}
            >
              Entrar como {String(client.full_name || client.name || "cliente").split(" ")[0]}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- Uso ---------------- */

type Metric = "grains" | "messages" | "cost";
const METRIC: Record<Metric, { label: string; fmt: (d: any) => string }> = {
  grains: { label: "Grãos", fmt: (d) => grains(d.grains) },
  messages: { label: "Mensagens", fmt: (d) => `${int(d.messages)} msg` },
  cost: { label: "Custo", fmt: (d) => usd(d.cost) },
};

/** Barras por dia; tocar ou passar o mouse mostra o dia (sem tooltip flutuante: a leitura fica em cima). */
function Bars({ daily, metric, compact }: { daily: any[]; metric: Metric; compact?: boolean }) {
  const [sel, setSel] = useState<any | null>(null);
  const val = (d: any) => Number(d[metric] ?? 0);
  const max = Math.max(1e-9, ...daily.map(val));
  const shown = sel ?? daily[daily.length - 1];
  if (!daily.length) return null;
  return (
    <div className={`cs-bars-wrap${compact ? " compact" : ""}`}>
      <div className="cs-readout">
        <strong>{METRIC[metric].fmt(shown)}</strong>
        <span className="muted">{sel ? `${weekday(shown.day)}, ${ymd(shown.day)}` : "hoje"} · {int(shown.messages)} msg · {int(shown.executions)} resp. · {usd(shown.cost)}</span>
      </div>
      <div className="cs-bars" onMouseLeave={() => setSel(null)} role="list" aria-label={`${METRIC[metric].label} por dia`}>
        {daily.map((d) => (
          <span key={d.day} role="listitem" className={sel?.day === d.day ? "on" : ""} onMouseEnter={() => setSel(d)} onClick={() => setSel(sel?.day === d.day ? null : d)} aria-label={`${ymd(d.day)}: ${METRIC[metric].fmt(d)}`}>
            <i style={{ height: `${Math.max(val(d) > 0 ? 4 : 0, (val(d) / max) * 100)}%` }} />
          </span>
        ))}
      </div>
      <div className="cs-axis muted"><span>{ymd(daily[0].day)}</span><span>hoje</span></div>
    </div>
  );
}

function Uso({ data, days, setDays }: { data: any; days: number; setDays: (n: number) => void }) {
  const [metric, setMetric] = useState<Metric>("grains");
  const daily: any[] = data.daily ?? [];
  const sum = (k: string) => daily.reduce((acc, d) => acc + Number(d[k] ?? 0), 0);
  const active = daily.filter((d) => d.messages > 0 || d.executions > 0 || d.cost > 0);
  const t = data.totals ?? {};
  const equivalent = daily.some((d) => d.grains > 0 && !d.charged);
  return (
    <div className="cs-pane">
      <div className="cs-toolbar">
        <div className="seg cs-mini-seg" role="group" aria-label="Período">
          {[7, 14, 30, 90].map((d) => (
            <button key={d} className={days === d ? "active" : ""} aria-pressed={days === d} onClick={() => setDays(d)}>{d} dias</button>
          ))}
        </div>
        <div className="seg cs-mini-seg" role="group" aria-label="O que mostrar">
          {(Object.keys(METRIC) as Metric[]).map((m) => (
            <button key={m} className={metric === m ? "active" : ""} aria-pressed={metric === m} onClick={() => setMetric(m)}>{METRIC[m].label}</button>
          ))}
        </div>
      </div>

      <div className="cs-nums">
        <div><small>Mensagens</small><strong>{int(sum("messages"))}</strong></div>
        <div><small>Respostas</small><strong>{int(sum("executions"))}</strong></div>
        <div><small>Grãos</small><strong>{int(sum("grains"))}</strong></div>
        <div><small>Custo de IA</small><strong>{usd(sum("cost"))}</strong></div>
        <div><small>Tokens</small><strong>{int(sum("tokens"))}</strong></div>
        <div><small>Média por dia ativo</small><strong>{active.length ? int(sum("grains") / active.length) : 0} grãos</strong></div>
      </div>

      <section className="cs-card">
        <Bars daily={daily} metric={metric} />
        {equivalent && <p className="cs-note">Ele não gasta grãos de verdade (liberado ou cobrança desligada): os grãos mostram o equivalente pelo custo.</p>}
      </section>

      <section className="cs-card">
        <div className="cs-card-head"><h4>Dia a dia</h4><span className="muted">{active.length} {active.length === 1 ? "dia com uso" : "dias com uso"}</span></div>
        {active.length ? (
          <div className="cs-table" role="table" aria-label="Uso por dia">
            <div className="cs-tr cs-th" role="row"><span role="columnheader">Dia</span><span role="columnheader">Msg</span><span role="columnheader">Resp.</span><span role="columnheader">Grãos</span><span role="columnheader">Custo</span></div>
            {[...active].reverse().map((d) => (
              <div key={d.day} className="cs-tr" role="row">
                <span role="cell">{ymd(d.day)} <em>{weekday(d.day)}</em></span>
                <span role="cell">{int(d.messages)}</span>
                <span role="cell">{int(d.executions)}</span>
                <span role="cell">{int(d.grains)}</span>
                <span role="cell">{usd(d.cost)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted cs-empty">Sem uso nesse período.</p>
        )}
      </section>

      {(data.byAgent?.length > 0 || data.tools?.length > 0) && (
        <div className="cs-split">
          {data.byAgent?.length > 0 && (
            <section className="cs-card">
              <div className="cs-card-head"><h4>Quem trabalhou para ele</h4><span className="muted">7 dias</span></div>
              {data.byAgent.map((a: any) => (
                <div key={a.agent} className="cs-row">
                  <span className="grow"><AgentTag id={a.agent} /></span>
                  <span className="cs-row-val">{int(a.calls)} <em>chamadas</em></span>
                  <span className="cs-row-val hide-phone">{usd(a.cost)}</span>
                </div>
              ))}
            </section>
          )}
          {data.tools?.length > 0 && (
            <section className="cs-card">
              <div className="cs-card-head"><h4>O que mais pediu</h4><span className="muted">ferramentas, 7 dias</span></div>
              {data.tools.map((x: any) => (
                <div key={x.name} className="cs-row">
                  <span className="grow ellipsis cs-mono">{x.name}</span>
                  <span className="cs-row-val">{int(x.n)}×</span>
                </div>
              ))}
            </section>
          )}
        </div>
      )}
      <p className="cs-note">
        Mensagens, grãos e custo por dia ficam guardados para sempre. Agentes e ferramentas vêm das execuções, que somem depois de 7 dias.
        {t.errors_7d ? ` Teve ${t.errors_7d} ${t.errors_7d === 1 ? "erro" : "erros"} na semana.` : ""}
      </p>
    </div>
  );
}

/* ---------------- Plano ---------------- */

function Plano({ id, name, data, reload }: { id: string; name: string; data: any; reload: () => unknown }) {
  const b = data.billing;
  const payments = useApi<any>(`/api/clients/${id}/payments`);
  if (!b) return null;
  const sub = b.subscription;
  const st = STATE[b.state];
  const due = sub?.active ? daysUntil(sub.nextDueDate) : null;
  const planMax = Math.max(1, sub?.plan?.grains ?? b.wallet.plan);
  const gift = async () => {
    let amount = "500";
    const ok = await confirmDialog({
      title: `Dar grãos para ${name.split(" ")[0]}`,
      body: (
        <>
          <span style={{ display: "block", marginBottom: 10 }}>Entram nos grãos extras, que não vencem. Aparece no extrato como ajuste.</span>
          <input className="input" type="number" inputMode="numeric" min={1} max={100000} defaultValue={amount} aria-label="Quantos grãos" onChange={(e) => (amount = e.target.value)} />
        </>
      ),
      confirmLabel: "Dar grãos",
    });
    if (!ok) return;
    const n = Math.round(Number(amount));
    if (!(n >= 1 && n <= 100_000)) return alertDialog("Quantidade inválida", "Informe de 1 a 100.000 grãos.");
    await api(`/api/billing/people/${id}/grains`, { method: "POST", json: { amount: n, note: "Presente do responsável" } });
    await reload();
  };
  const exempt = async (value: boolean) => {
    const ok = await confirmDialog({
      title: value ? "Liberar sem cobrança?" : "Voltar a cobrar?",
      body: value ? `${name.split(" ")[0]} passa a usar sem gastar grãos.` : `${name.split(" ")[0]} volta a gastar grãos a cada resposta.`,
      confirmLabel: value ? "Liberar" : "Voltar a cobrar",
    });
    if (!ok) return;
    await api(`/api/billing/people/${id}`, { method: "PATCH", json: { exempt: value } });
    await reload();
  };
  return (
    <div className="cs-pane">
      <section className="cs-card cs-plan">
        <div className="cs-card-head">
          <div>
            <small className="cs-eyebrow">Situação</small>
            <h3 className="cs-plan-name">{sub?.active && sub.plan ? `Plano ${sub.plan.name}` : st?.label}</h3>
          </div>
          {st && <span className={`badge ${st.tone}`}>{st.label}</span>}
        </div>
        <p className="cs-note" style={{ marginTop: 0 }}>{b.state === "trial" && b.trialUntil ? `Período livre até ${dateBR(b.trialUntil)}.` : st?.hint}</p>
        {sub?.active ? (
          <dl className="cs-kv">
            <dt>Mensalidade</dt>
            <dd>{brl(sub.value)}{sub.discount > 0 ? ` (${sub.discount}% de desconto${sub.baseValue ? ` sobre ${brl(sub.baseValue)}` : ""})` : ""}</dd>
            <dt>Próximo pagamento</dt><dd><strong>{ymd(sub.nextDueDate, true)}</strong> {inDays(due) && <span className="muted">· {inDays(due)}</span>}</dd>
            <dt>Pagamento</dt><dd>{sub.card ? `${sub.card.brand ?? "Cartão"} final ${sub.card.last4}` : METHOD[sub.method] ?? sub.method ?? "–"}</dd>
            <dt>Pago até</dt><dd>{ymd(sub.paidUntil, true)}</dd>
            <dt>Último pagamento</dt><dd>{sub.lastPaymentAt ? dateBR(sub.lastPaymentAt) : "ainda não pagou"}</dd>
            <dt>Assinante desde</dt><dd>{dateBR(sub.since)}</dd>
            {sub.plan && <><dt>Recarga</dt><dd>{grains(sub.plan.grains)} por mês</dd></>}
            {sub.nextPlan && <><dt>Troca agendada</dt><dd>para o plano {sub.nextPlan.name} na próxima cobrança</dd></>}
          </dl>
        ) : sub && !sub.active ? (
          <p className="muted cs-empty">Teve plano e cancelou{sub.paidUntil ? `; pago até ${ymd(sub.paidUntil, true)}` : ""}.</p>
        ) : null}
        {sub?.invoiceUrl && <a className="btn btn-sm cs-invoice" href={sub.invoiceUrl} target="_blank" rel="noreferrer">Abrir cobrança em aberto <Icon name="external" size={14} /></a>}
      </section>

      <section className="cs-card">
        <div className="cs-card-head"><h4>Grãos</h4><span className="muted">{b.burnPerDay ? `gasta uns ${int(b.burnPerDay)} por dia` : "sem gasto recente"}</span></div>
        <div className="cs-wallet">
          <div className="cs-wallet-total"><strong>{int(b.wallet.total)}</strong><span>{b.daysLeft != null && b.state !== "exempt" && b.state !== "off" ? `dura uns ${b.daysLeft} dias` : "grãos no saldo"}</span></div>
          <div className="cs-bucket">
            <div className="cs-bucket-row"><span>Do plano</span><strong>{int(b.wallet.plan)}{sub?.plan ? <em> de {int(sub.plan.grains)}</em> : null}</strong></div>
            <div className="cs-meter"><i style={{ width: `${Math.min(100, (b.wallet.plan / planMax) * 100)}%` }} /></div>
            <div className="cs-bucket-row"><span>Extras (não vencem)</span><strong>{int(b.wallet.extra)}</strong></div>
            {!b.wallet.created && <p className="cs-note">Ainda sem carteira: ganha os grãos de boas-vindas na primeira mensagem.</p>}
          </div>
        </div>
        <div className="cs-plan-facts">
          <span>{b.packs.count ? `${b.packs.count} ${b.packs.count === 1 ? "pacote comprado" : "pacotes comprados"} · ${brl(b.packs.value)}` : "Nenhum pacote avulso"}</span>
          <span>1 US$ = {int(b.grainsPerUsd)} grãos</span>
        </div>
        <div className="cs-actions">
          <button className="btn btn-sm" onClick={gift}>Dar grãos</button>
          {b.enabled && b.state !== "exempt" && <button className="btn btn-sm" onClick={() => exempt(true)}>Liberar sem cobrança</button>}
          {b.state === "exempt" && data.billing && <button className="btn btn-sm" onClick={() => exempt(false)}>Voltar a cobrar</button>}
        </div>
      </section>

      <section className="cs-card">
        <div className="cs-card-head"><h4>Extrato de grãos</h4><span className="muted">últimos {b.ledger.length}</span></div>
        {b.ledger.length ? (
          b.ledger.map((l: any, i: number) => (
            <div key={i} className="cs-row">
              <span className="grow">
                {l.label}
                {l.note ? <span className="muted"> · {l.note}</span> : null}
                <span className="cs-row-sub">{l.day ? ymd(l.day, true) : dateBR(l.at)}</span>
              </span>
              <span className={`cs-row-val ${l.delta > 0 ? "cs-in" : ""}`}>{l.delta > 0 ? "+" : "−"}{int(Math.abs(l.delta))}</span>
            </div>
          ))
        ) : (
          <p className="muted cs-empty">Nada no extrato ainda.</p>
        )}
      </section>

      <section className="cs-card">
        <div className="cs-card-head"><h4>Cobranças no Asaas</h4>{payments.data?.payments?.length ? <span className="muted">{payments.data.payments.length}</span> : null}</div>
        {!payments.data ? (
          <p className="muted cs-empty">Buscando no Asaas…</p>
        ) : payments.data.payments.length ? (
          payments.data.payments.map((p: any) => (
            <div key={p.id} className="cs-row">
              <span className="grow">
                <span className="ellipsis" style={{ display: "block", maxWidth: "none" }}>{p.description}</span>
                <span className="cs-row-sub">{p.paid ? `pago em ${ymd(p.paidAt, true)}` : `vence ${ymd(p.dueDate, true)}`}{p.method ? ` · ${p.method}` : ""}</span>
              </span>
              <span className="cs-pay">
                <strong>{brl(p.value)}</strong>
                <span className={`badge ${p.paid ? "badge-ok" : p.open ? (p.status === "Vencida" ? "badge-err" : "badge-warn") : ""}`}>{p.status}</span>
              </span>
            </div>
          ))
        ) : (
          <p className="muted cs-empty">{payments.data.error ? `Não deu para ler o Asaas: ${payments.data.error}` : "Nenhuma cobrança ainda."}</p>
        )}
      </section>
    </div>
  );
}

/* ---------------- Perfil ---------------- */

const MODULE_LABEL: Record<string, string> = { memorias: "O que ele sabe", meu_time: "Meu time" };

function Perfil({ client, data, status, setStatus, reload, onClose }: { client: any; data: any; status: string; setStatus: (s: string) => void; reload: () => unknown; onClose: () => void }) {
  const memories = useApi<any[]>(`/api/memories?user=${client.id}`);
  const f = data.features ?? {};
  const first = String(client.full_name || client.name || "esta pessoa").split(" ")[0];
  const patch = async (body: any) => {
    const r = await api(`/api/clients/${client.id}`, { method: "PATCH", json: body });
    setStatus(r.status);
  };
  const toggle = async (m: string) => {
    const modules = data.tabs.modules.includes(m) ? data.tabs.modules.filter((x: string) => x !== m) : [...data.tabs.modules, m];
    await api(`/api/clients/${client.id}/tabs`, { method: "PUT", json: { modules } });
    void reload();
  };
  const removeTab = async (slug: string) => {
    await api(`/api/clients/${client.id}/tabs`, { method: "PUT", json: { custom: data.tabs.custom.filter((c: any) => c.slug !== slug) } });
    void reload();
  };
  const uses: [string, number, string?][] = [
    ["Lançamentos", f.transactions, f.transactionsMonth ? `${int(f.transactionsMonth)} no mês` : undefined],
    ["Lembretes agendados", f.reminders],
    ["Alarmes", f.alarms],
    ["De olho", f.watches],
    ["Contas fixas", f.bills],
    ["Cartões", f.cards],
    ["Limites", f.budgets],
    ["Metas", f.goals],
    ["Documentos", f.documents],
    ["Contatos na agenda", f.phonebook],
    ["Amigos no Planejai", f.contacts],
    ["Recados", f.errands],
    ["Na lista de compras", f.shopping],
    ["Reuniões gravadas", f.meetings],
    ["Memórias", f.memories],
    ["Automações", f.automations],
  ];
  return (
    <div className="cs-pane">
      <section className="cs-card">
        <h4>Contato e conta</h4>
        <dl className="cs-kv">
          <dt>WhatsApp</dt><dd>{client.phone ? phoneFmt(client.phone) : "–"}</dd>
          <dt>E-mail</dt><dd className="cs-break">{client.email ?? "–"}</dd>
          <dt>Convidado por</dt><dd>{client.invited_by_name ?? "–"}</dd>
          <dt>Convites</dt><dd>{client.invites_accepted ?? 0} aceitos de {client.invites_sent ?? 0} enviados</dd>
          <dt>Painel</dt>
          <dd>
            {client.account_id ? (
              <span className="cs-inline"><span className="cs-break">{client.account_email}</span> <Status status={client.account_status === "disabled" ? "blocked" : client.account_status} /></span>
            ) : (
              "ainda não criou senha"
            )}
          </dd>
          <dt>Integrações</dt><dd>{f.integrations?.length ? f.integrations.join(", ") : "nenhuma conectada"}</dd>
        </dl>
      </section>

      <section className="cs-card">
        <div className="cs-card-head"><h4>O que ele tem no app</h4><span className="muted">só a quantidade, nunca o conteúdo</span></div>
        <div className="cs-uses">
          {uses.map(([label, n, sub]) => (
            <div key={label} className={Number(n) ? "" : "zero"}>
              <strong>{int(n)}</strong>
              <span>{label}</span>
              {sub && <em>{sub}</em>}
            </div>
          ))}
        </div>
      </section>

      <section className="cs-card">
        <h4>Agentes criados para ele</h4>
        {(data.agents ?? []).map((a: any) => (
          <div key={a.id} className="cs-row" style={{ opacity: a.active ? 1 : 0.5 }}>
            <span className="face-tile" style={{ width: 36, height: 36 }}><AgentFace face={a.face} size={36} /></span>
            <span className="grow" style={{ minWidth: 0 }}>
              <strong>{a.persona}</strong> <span className="muted">· {a.name}</span>
              <span className="cs-row-sub ellipsis" style={{ maxWidth: "none" }}>{a.focus} · criado {ago(a.created_at)}</span>
            </span>
            <span className="cs-row-val">{a.uses} <em>{a.uses === 1 ? "uso" : "usos"}</em></span>
          </div>
        ))}
        {!data.agents?.length && <p className="muted cs-empty">Nenhum ainda. A reunião das 19h cria quando um assunto se repete.</p>}
      </section>

      {(memories.data?.length ?? 0) > 0 && (
        <section className="cs-card">
          <div className="cs-card-head"><h4>O que ele sabe</h4><span className="muted">{memories.data!.length}</span></div>
          {memories.data!.slice(0, 12).map((m) => (
            <div key={m.id} className="cs-row">
              <span className="grow">{m.content}</span>
              <button className="icon-btn" aria-label="Apagar memória" onClick={async () => { await api(`/api/memories/${m.id}`, { method: "DELETE" }); void memories.reload(); }}>
                <Icon name="x" size={14} />
              </button>
            </div>
          ))}
        </section>
      )}

      {(data.styleNotes || data.notes?.length > 0) && (
        <section className="cs-card">
          <h4>O que o time aprendeu</h4>
          {data.styleNotes && <div className="cs-row" style={{ alignItems: "flex-start" }}><span className="persona">{CORE_FACES.cto.persona}</span><span className="grow">{data.styleNotes}</span></div>}
          {(data.notes ?? []).map((n: any) => (
            <div key={n.agent} className="cs-row" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
              <span style={{ width: 150, flexShrink: 0 }}><AgentTag id={n.agent} /></span>
              <span className="grow" style={{ flexBasis: 180 }}>{n.user_note && <>Pedido dela: {n.user_note}{n.note ? ". " : ""}</>}{n.note && <>Aprendido nas reuniões: {n.note}</>}</span>
            </div>
          ))}
        </section>
      )}
      {data.private && <p className="cs-note">O que o time aprendeu sobre a pessoa e os assuntos dela fica só com ela.</p>}

      <section className="cs-card">
        <h4>Abas do app</h4>
        <p className="cs-note" style={{ marginTop: 0 }}>Início, Agenda, Finanças e De olho sempre aparecem. O resto a reunião noturna libera conforme o uso, ou você liga aqui.</p>
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
      </section>

      <section className="cs-card">
        <h4>Acesso</h4>
        <div className="cs-danger">
          <div className="cs-danger-row">
            <span className="grow">
              <strong>{status === "blocked" ? "Bloqueado" : status === "pending" ? "Aguardando aprovação" : "Liberado no WhatsApp"}</strong>
              <span className="cs-row-sub">{status === "blocked" ? "O assistente não responde esta pessoa." : "O assistente responde normalmente."}</span>
            </span>
            {status !== "active" && <button className="btn btn-sm btn-primary" onClick={() => patch({ status: "active" })}>Liberar</button>}
            {status !== "blocked" && <button className="btn btn-sm btn-danger" onClick={() => patch({ status: "blocked" })}>Bloquear</button>}
          </div>
          <div className="cs-danger-row">
            <span className="grow">
              <strong>Zerar contexto</strong>
              <span className="cs-row-sub">Esquece a conversa e começa do zero. Conta e dados ficam.</span>
            </span>
            <button
              className="btn btn-sm"
              onClick={async () => {
                let deep = false;
                const ok = await confirmDialog({
                  title: "Zerar o contexto?",
                  body: (
                    <>
                      <span style={{ display: "block", margin: "0 0 10px" }}>
                        O assistente esquece a conversa com {first}: memória curta (Redis), resumo, o que esperava o "sim" e arquivos recentes. Cadastro, gastos, lembretes,
                        documentos e contatos ficam.
                      </span>
                      <label className="row" style={{ gap: 8, fontSize: 14 }}>
                        <input type="checkbox" onChange={(e) => (deep = e.target.checked)} />
                        Apagar também o que ele aprendeu (memórias e jeito de falar)
                      </label>
                    </>
                  ),
                  confirmLabel: "Zerar",
                  danger: true,
                });
                if (!ok) return;
                const r = await api(`/api/clients/${client.id}/reset-context`, { method: "POST", json: { memories: deep } });
                void memories.reload();
                await alertDialog("Contexto zerado", `A próxima conversa começa do zero${r.memories ? `, sem as ${r.memories} memórias` : ""}.`);
              }}
            >
              Zerar
            </button>
          </div>
          <div className="cs-danger-row">
            <span className="grow">
              <strong>Apagar dados</strong>
              <span className="cs-row-sub">Pedido de exclusão (LGPD): some o cadastro e tudo dele. Não tem volta.</span>
            </span>
            <button
              className="btn btn-sm btn-danger"
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
              Apagar
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
