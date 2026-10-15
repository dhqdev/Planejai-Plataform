import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ago, api, ms, usd } from "../api";
import { Empty, ErrorBox, Loading, Modal, PageHead } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";

/**
 * Esteira de desenvolvimento (só o dono): chamado escrito aqui passa sozinho por entender, planejar,
 * codar, revisar, abrir PR e esperar o CI. Quadro com os chamados por situação e, em cada um,
 * a linha do tempo com o que cada etapa viu, decidiu e custou.
 */

interface Status {
  ready: boolean;
  missing?: string;
  repo?: string;
  base?: string;
  costCap?: number;
  stages: Record<string, string>;
}
interface Ticket {
  id: number;
  title: string;
  spec_title: string | null;
  kind: string;
  stage: string;
  failed_stage: string | null;
  pr_number: number | null;
  pr_url: string | null;
  fix_rounds: number;
  error: string | null;
  cost_usd: number;
  created_at: string;
  stage_started_at: string;
}
interface Step {
  id: number;
  stage: string;
  name: string;
  status: string;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  duration_ms: number;
  summary: string | null;
  detail: any;
  execution_id: string | null;
  created_at: string;
}
interface Detail extends Ticket {
  description: string;
  spec: any;
  plan: any;
  review: any;
  branch: string | null;
  ci: any;
  tokens_in: number;
  tokens_out: number;
  files: { path: string; deleted: boolean; diff: string }[] | null;
  changes_summary: string | null;
  steps: Step[];
}

/** Título que o analista deu, se for um título de verdade; senão o que o dono escreveu. */
const titleOf = (t: { title: string; spec_title?: string | null; spec?: any }) => {
  const s = (t.spec_title ?? t.spec?.titulo ?? "").trim();
  return s.length > 3 ? s : t.title;
};

/** A ordem das etapas na barrinha de progresso de cada chamado. */
const FLOW = ["entendendo", "planejando", "codando", "revisando", "abrindo_pr", "testando", "pronto"];
const WORKING = new Set(["fila", "entendendo", "planejando", "codando", "revisando", "abrindo_pr", "testando", "corrigindo"]);
const STOPPED = new Set(["precisa_de_voce", "falhou", "cancelado"]);
const KIND: Record<string, string> = { bug: "Bug", melhoria: "Melhoria", nova: "Coisa nova" };

const COLUMNS: { key: string; label: string; has: (s: string) => boolean }[] = [
  { key: "fila", label: "Na fila", has: (s) => s === "fila" },
  { key: "andando", label: "Andando", has: (s) => WORKING.has(s) && s !== "fila" },
  { key: "pronto", label: "Pronto para revisar", has: (s) => s === "pronto" },
  { key: "parado", label: "Parado", has: (s) => STOPPED.has(s) },
];

function progress(stage: string, failed: string | null) {
  const at = stage === "corrigindo" ? "testando" : STOPPED.has(stage) ? failed ?? "entendendo" : stage;
  return Math.max(0, FLOW.indexOf(at));
}

function StageBadge({ stage, label }: { stage: string; label: string }) {
  const cls = stage === "pronto" ? "badge-ok" : stage === "falhou" ? "badge-err" : stage === "precisa_de_voce" ? "badge-warn" : WORKING.has(stage) ? "badge-info" : "";
  return (
    <span className={`badge ${cls}`}>
      {WORKING.has(stage) && stage !== "fila" && <span className="dot dot-warn dev-live" />}
      {label}
    </span>
  );
}

function Flow({ stage, failed }: { stage: string; failed: string | null }) {
  const at = progress(stage, failed);
  return (
    <div className={`dev-flow${stage === "falhou" ? " bad" : ""}`} aria-hidden>
      {FLOW.map((s, i) => <i key={s} className={i < at || stage === "pronto" ? "done" : i === at && stage !== "fila" ? "now" : ""} />)}
    </div>
  );
}

export function EsteiraPage() {
  const status = useApi<Status>("/api/dev/status");
  const list = useApi<Ticket[]>("/api/dev/tickets", { poll: 5000 });
  const [params, setParams] = useSearchParams();
  const open = Number(params.get("t")) || null;
  const [creating, setCreating] = useState(false);
  const labels = status.data?.stages ?? {};

  const openTicket = (id: number | null) => {
    const p = new URLSearchParams(params);
    if (id) p.set("t", String(id));
    else p.delete("t");
    setParams(p, { replace: !id });
  };

  if (list.error) return <div className="page"><ErrorBox error={list.error} /></div>;
  if (!list.data || !status.data) return <Loading />;
  const tickets = list.data;

  return (
    <div className="page page-wide dev-page">
      <PageHead
        title="Esteira"
        subtitle={status.data.ready ? `Chamados viram PR sozinhos em ${status.data.repo} (base ${status.data.base}). Você só revisa e mescla.` : "Chamados viram branch, código, teste e PR sozinhos. Você só revisa e mescla."}
        actions={
          <button className="btn btn-primary" onClick={() => { haptic(); setCreating(true); }} disabled={!status.data.ready}>
            <Icon name="plus" size={16} /> Novo chamado
          </button>
        }
      />
      {!status.data.ready && (
        <div className="card card-pad dev-setup">
          <Icon name="github" size={20} />
          <div>
            <strong>Falta ligar o GitHub da esteira</strong>
            <p className="muted">{status.data.missing}</p>
          </div>
          <Link className="btn btn-sm" to="/integrations">Abrir Integrações</Link>
        </div>
      )}

      {!tickets.length ? (
        <div className="card">
          <Empty>Nenhum chamado ainda. Escreva o que quer mudar, do jeito que você falaria para um dev, e a esteira cuida do resto.</Empty>
        </div>
      ) : (
        <div className="dev-board">
          {COLUMNS.map((col) => {
            const items = tickets.filter((t) => col.has(t.stage));
            return (
              <section key={col.key} className="dev-col">
                <header>
                  <span>{col.label}</span>
                  <span className="muted">{items.length}</span>
                </header>
                {items.map((t) => (
                  <button key={t.id} className="dev-card" onClick={() => { haptic(5); openTicket(t.id); }}>
                    <div className="dev-card-top">
                      <span className="muted mono">#{t.id}</span>
                      <span className="muted">{KIND[t.kind] ?? t.kind}</span>
                      <span className="spacer" />
                      <span className="muted mono">{usd(t.cost_usd)}</span>
                    </div>
                    <strong className="dev-card-title">{titleOf(t)}</strong>
                    <Flow stage={t.stage} failed={t.failed_stage} />
                    <div className="dev-card-foot">
                      <StageBadge stage={t.stage} label={labels[t.stage] ?? t.stage} />
                      {t.pr_number && <span className="muted">PR #{t.pr_number}</span>}
                      <span className="spacer" />
                      <span className="muted">{ago(t.stage_started_at)}</span>
                    </div>
                  </button>
                ))}
                {!items.length && <div className="dev-col-empty muted">Nada aqui</div>}
              </section>
            );
          })}
        </div>
      )}

      {creating && <NewTicket onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); void list.reload(); openTicket(id); }} />}
      {open && <TicketModal id={open} labels={labels} onClose={() => openTicket(null)} onChange={() => void list.reload()} />}
    </div>
  );
}

function NewTicket({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState("melhoria");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ id: number }>("/api/dev/tickets", { method: "POST", json: { title, description, kind } });
      haptic();
      onCreated(r.id);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Novo chamado"
      onClose={onClose}
      footer={(close) => (
        <>
          <button className="btn" onClick={close}>Cancelar</button>
          <button className="btn btn-primary" disabled={busy || title.trim().length < 3 || description.trim().length < 10} onClick={send}>
            {busy ? "Mandando…" : "Mandar para a esteira"}
          </button>
        </>
      )}
    >
      <div className="seg dev-kind" role="group" aria-label="Tipo">
        {Object.entries(KIND).map(([k, v]) => (
          <button key={k} className={kind === k ? "active" : ""} aria-pressed={kind === k} onClick={() => setKind(k)}>{v}</button>
        ))}
      </div>
      <div className="field">
        <label htmlFor="dev-title">Título</label>
        <input id="dev-title" className="input" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: lembrete repetido não para depois de cancelar" autoFocus />
      </div>
      <div className="field">
        <label htmlFor="dev-desc">O que acontece e o que você quer</label>
        <textarea id="dev-desc" className="input" rows={7} value={description} maxLength={8000} onChange={(e) => setDescription(e.target.value)} placeholder="Conte como falaria para um dev: onde aparece, o que esperava e, se souber, como reproduzir." />
      </div>
      <p className="muted dev-hint">A esteira descreve melhor o problema, planeja, escreve o código, revisa, abre um PR em rascunho e espera o CI. Nada vai para a main sem você mesclar.</p>
      {err && <ErrorBox error={err} />}
    </Modal>
  );
}

function TicketModal({ id, labels, onClose, onChange }: { id: number; labels: Record<string, string>; onClose: () => void; onChange: () => void }) {
  const { data, error, reload } = useApi<Detail>(`/api/dev/tickets/${id}`, { poll: 4000 });
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setErr(null), [id]);

  const act = async (path: string, json?: unknown) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/dev/tickets/${id}/${path}`, { method: "POST", json });
      haptic();
      setAnswer("");
      await reload();
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const t = data;
  return (
    <Modal title={t ? `#${t.id} ${titleOf(t)}` : "Chamado"} wide onClose={onClose} className="dev-modal">
      {error && <ErrorBox error={error} />}
      {!t ? (
        <Loading />
      ) : (
        <div className="dev-detail">
          <div className="dev-detail-head">
            <StageBadge stage={t.stage} label={labels[t.stage] ?? t.stage} />
            <span className="muted">{KIND[t.kind] ?? t.kind} · aberto {ago(t.created_at)}</span>
            <span className="spacer" />
            <span className="mono">{usd(t.cost_usd)}</span>
          </div>
          <Flow stage={t.stage} failed={t.failed_stage} />

          <div className="dev-actions">
            {t.pr_url && (
              <a className="btn btn-sm btn-primary" href={t.pr_url} target="_blank" rel="noreferrer">
                <Icon name="github" size={14} /> Abrir PR #{t.pr_number}
              </a>
            )}
            {(t.stage === "falhou" || t.stage === "cancelado") && (
              <button className="btn btn-sm" disabled={busy} onClick={() => act("retry")}>
                <Icon name="refresh" size={14} /> Tentar de novo
              </button>
            )}
            {WORKING.has(t.stage) && (
              <button className="btn btn-sm" disabled={busy} onClick={() => act("cancel")}>
                <Icon name="x" size={14} /> Parar
              </button>
            )}
          </div>

          {t.error && <div className="dev-error">{t.error}</div>}

          {t.stage === "precisa_de_voce" && (
            <div className="dev-ask">
              <strong>A esteira precisa saber</strong>
              <ul>{(t.spec?.perguntas ?? []).map((q: string, i: number) => <li key={i}>{q}</li>)}</ul>
              <textarea className="input" rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Sua resposta" />
              <button className="btn btn-sm btn-primary" disabled={busy || !answer.trim()} onClick={() => act("answer", { text: answer })}>Responder e continuar</button>
            </div>
          )}
          {err && <ErrorBox error={err} />}

          {t.spec?.problema && (
            <section className="dev-sec">
              <h4>Como a esteira entendeu</h4>
              <dl className="kv">
                <dt>Problema</dt><dd>{t.spec.problema}</dd>
                <dt>Esperado</dt><dd>{t.spec.esperado}</dd>
                {t.spec.riscos?.length > 0 && <><dt>Riscos</dt><dd>{t.spec.riscos.join("; ")}</dd></>}
              </dl>
              {t.spec.criterios?.length > 0 && (
                <ul className="dev-checks">{t.spec.criterios.map((c: string, i: number) => <li key={i}><Icon name="check" size={13} /> {c}</li>)}</ul>
              )}
            </section>
          )}

          {t.plan?.passos?.length > 0 && (
            <section className="dev-sec">
              <h4>Plano</h4>
              <ol className="dev-plan">{t.plan.passos.map((p: string, i: number) => <li key={i}>{p}</li>)}</ol>
              {t.plan.testes && <p className="muted">Teste: {t.plan.testes}</p>}
            </section>
          )}

          {t.files?.length ? (
            <section className="dev-sec">
              <h4>Código ({t.files.length} {t.files.length === 1 ? "arquivo" : "arquivos"})</h4>
              {t.changes_summary && <p>{t.changes_summary}</p>}
              {t.files.map((f) => (
                <details key={f.path} className="dev-file">
                  <summary><span className="mono ellipsis">{f.path}</span>{f.deleted && <span className="badge badge-err">apagado</span>}</summary>
                  <pre className="dev-diff">{f.diff.split("\n").map((l, i) => <span key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : ""}>{l}{"\n"}</span>)}</pre>
                </details>
              ))}
            </section>
          ) : null}

          {t.review?.problemas?.length > 0 && (
            <section className="dev-sec">
              <h4>Revisor</h4>
              <ul>{t.review.problemas.map((p: string, i: number) => <li key={i}>{p}</li>)}</ul>
            </section>
          )}

          {t.ci?.log && (
            <section className="dev-sec">
              <h4>Log do CI</h4>
              <pre className="dev-diff">{t.ci.log}</pre>
            </section>
          )}

          <section className="dev-sec">
            <h4>Linha do tempo</h4>
            <ol className="dev-steps">
              {t.steps.map((s) => (
                <li key={s.id} className={s.status === "error" ? "bad" : ""}>
                  <span className="dev-step-dot" />
                  <div className="dev-step-main">
                    <div className="dev-step-top">
                      <strong>{s.name}</strong>
                      <span className="muted">{labels[s.stage] ?? s.stage}</span>
                      <span className="spacer" />
                      {s.cost_usd > 0 && <span className="mono">{usd(s.cost_usd)}</span>}
                    </div>
                    {s.summary && <div className="dev-step-sum">{s.summary}</div>}
                    <div className="muted dev-step-meta">
                      {s.model && <span className="mono">{s.model}</span>}
                      {s.tokens_in + s.tokens_out > 0 && <span>{s.tokens_in.toLocaleString("pt-BR")} entrada · {s.tokens_out.toLocaleString("pt-BR")} saída</span>}
                      {s.duration_ms > 0 && <span>{ms(s.duration_ms)}</span>}
                      {s.execution_id && <Link to={`/executions/${s.execution_id}`}>ver em Execuções</Link>}
                    </div>
                  </div>
                </li>
              ))}
              {!t.steps.length && <li className="muted dev-steps-empty">Ainda na fila.</li>}
            </ol>
          </section>

          <details className="dev-file">
            <summary>Pedido original</summary>
            <p className="dev-original">{t.description}</p>
          </details>
        </div>
      )}
    </Modal>
  );
}

interface Costs {
  days: number;
  total: { cost: number; tokens_in: number; tokens_out: number; calls: number; tickets: number };
  done: { ready: number; failed: number; avg_ready: number };
  byStage: { stage: string; label: string; cost: number; calls: number; tickets: number; avg_ms: number }[];
  byModel: { model: string; cost: number; calls: number; tokens_in: number; tokens_out: number }[];
  byDay: { day: string; cost: number }[];
  top: { id: number; title: string; stage: string; pr_number: number | null; cost: number }[];
}

const int = (n: number | string) => Number(n ?? 0).toLocaleString("pt-BR");

/** Quanto a esteira custa: por etapa, por modelo, por dia e por chamado (só o dono). */
export function EsteiraCustosPage() {
  const [days, setDays] = useState(30);
  const { data, error } = useApi<Costs>(`/api/dev/costs?days=${days}`);
  const [hover, setHover] = useState<{ day: string; cost: number } | null>(null);
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;
  const fmtDay = (d: string) => d.split("-").reverse().slice(0, 2).join("/");
  const max = Math.max(1e-9, ...data.byDay.map((d) => d.cost));
  const topStage = Math.max(1e-9, ...data.byStage.map((s) => s.cost));
  const topModel = Math.max(1e-9, ...data.byModel.map((s) => s.cost));
  const topTicket = Math.max(1e-9, ...data.top.map((s) => s.cost));
  const perTicket = data.total.tickets ? data.total.cost / data.total.tickets : 0;
  return (
    <div className="page page-wide dev-page">
      <PageHead
        title="Custos da esteira"
        subtitle="Cada chamada de modelo da esteira, somada pelo custo real do OpenRouter. Os modelos de cada etapa se trocam em Agentes > Modelos (rotas Esteira)."
        actions={
          <div className="seg" role="group" aria-label="Período">
            {[7, 30, 90].map((d) => (
              <button key={d} className={days === d ? "active" : ""} aria-pressed={days === d} onClick={() => setDays(d)}>{d} dias</button>
            ))}
          </div>
        }
      />
      <div className="grid grid-4 dev-stats">
        <div className="card card-pad stat"><div className="label">Total no período</div><div className="value">{usd(data.total.cost)}</div><div className="sub">{data.total.tickets} {data.total.tickets === 1 ? "chamado" : "chamados"}</div></div>
        <div className="card card-pad stat"><div className="label">Por chamado</div><div className="value">{usd(perTicket)}</div><div className="sub">pronto custa em média {usd(data.done.avg_ready)}</div></div>
        <div className="card card-pad stat"><div className="label">Resultado</div><div className="value">{data.done.ready}<small className="muted"> / {data.done.ready + data.done.failed}</small></div><div className="sub">prontos · {data.done.failed} parados</div></div>
        <div className="card card-pad stat"><div className="label">Chamadas de modelo</div><div className="value">{int(data.total.calls)}</div><div className="sub">{int(data.total.tokens_in)} entrada · {int(data.total.tokens_out)} saída</div></div>
      </div>

      <div className="card card-pad costs-card">
        <div className="costs-label">Por dia</div>
        <div className="muted" style={{ fontSize: 13 }}>{hover ? `${fmtDay(hover.day)}: ${usd(hover.cost)}` : `últimos ${data.days} dias`}</div>
        {data.byDay.length ? (
          <>
            <div className="costs-bars" onMouseLeave={() => setHover(null)} aria-label="Custo por dia">
              {data.byDay.map((d) => (
                <span key={d.day} className={hover?.day === d.day ? "on" : ""} onMouseEnter={() => setHover(d)} onClick={() => setHover(d)} title={`${fmtDay(d.day)}: ${usd(d.cost)}`}>
                  <i style={{ height: `${Math.max(d.cost > 0 ? 3 : 0, (d.cost / max) * 100)}%` }} />
                </span>
              ))}
            </div>
            <div className="costs-axis muted"><span>{fmtDay(data.byDay[0]!.day)}</span><span>{fmtDay(data.byDay[data.byDay.length - 1]!.day)}</span></div>
          </>
        ) : (
          <Empty>Sem gasto no período.</Empty>
        )}
      </div>

      <div className="dev-cost-grid">
        <div className="card card-pad">
          <div className="costs-label">Por etapa</div>
          {data.byStage.map((s) => (
            <div key={s.stage} className="costs-row" role="row">
              <span className="ellipsis costs-name">{s.label}</span>
              <span className="costs-track"><i style={{ width: `${(s.cost / topStage) * 100}%` }} /></span>
              <span className="costs-val">{usd(s.cost)}</span>
              <span className="costs-sub muted hide-phone">{s.calls} chamadas · média {ms(s.avg_ms)}</span>
            </div>
          ))}
          {!data.byStage.length && <Empty>Nada ainda.</Empty>}
        </div>
        <div className="card card-pad">
          <div className="costs-label">Por modelo</div>
          {data.byModel.map((m) => (
            <div key={m.model} className="costs-row" role="row">
              <span className="ellipsis costs-name mono" title={m.model}>{m.model}</span>
              <span className="costs-track"><i style={{ width: `${(m.cost / topModel) * 100}%` }} /></span>
              <span className="costs-val">{usd(m.cost)}</span>
              <span className="costs-sub muted hide-phone">{m.calls} chamadas · {int(m.tokens_in)} / {int(m.tokens_out)} tokens</span>
            </div>
          ))}
          {!data.byModel.length && <Empty>Nada ainda.</Empty>}
        </div>
      </div>

      <div className="card card-pad">
        <div className="costs-label">Chamados mais caros</div>
        {data.top.map((t) => (
          <Link key={t.id} to={`/esteira?t=${t.id}`} className="costs-row">
            <span className="ellipsis costs-name">#{t.id} {t.title}</span>
            <span className="costs-track"><i style={{ width: `${(t.cost / topTicket) * 100}%` }} /></span>
            <span className="costs-val">{usd(t.cost)}</span>
            <span className="costs-sub muted hide-phone">{t.pr_number ? `PR #${t.pr_number}` : t.stage}</span>
          </Link>
        ))}
        {!data.top.length && <Empty>Nada ainda.</Empty>}
      </div>
    </div>
  );
}
