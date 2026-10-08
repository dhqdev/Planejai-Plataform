import { Fragment, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, phoneFmt } from "../../api";
import { ErrorBox, Modal, PageHead } from "../../components";
import { useApi } from "../../hooks";
import { Icon } from "../../icons";
import { haptic } from "../../touch";
import { AgentAvatar, StatusIcon } from "./Avatars";
import { PERIODS, STATUSES, useExecutionFilters } from "./filters";
import { agoShort, clock, dayLabel, dur, firstWords, fullWhen, pct, tok, usdBR } from "./format";
import { TRIGGER_ICON, TRIGGER_LABEL, agentMeta, channelOf, executionTitle, personOf, shortModel } from "./labels";

/* ================= Lista ================= */

export function ExecutionsPage() {
  const filters = useExecutionFilters();
  const { status, user, agent, since, trigger, search, active: filtered, set, clear } = filters;
  const [limit, setLimit] = useState(60);
  const [cleaning, setCleaning] = useState(false);
  const nav = useNavigate();

  const { data, error, reload } = useApi<any[]>(`/api/executions?${filters.query(limit)}`, { poll: 5000 });
  const summary = useApi<any>(`/api/executions/summary?since=${since || 24}`, { poll: 15000 });
  const s = summary.data;
  const periodShort = since === "1" ? "1 h" : since === "168" ? "7 dias" : since === "720" ? "30 dias" : "24 h";

  const groups = useMemo(() => {
    const out: [string, any[]][] = [];
    for (const e of data ?? []) {
      const k = dayLabel(e.started_at);
      const g = out.find(([gk]) => gk === k);
      if (g) g[1].push(e);
      else out.push([k, [e]]);
    }
    return out;
  }, [data]);

  return (
    <div className="page exl-page fit">
      <div className="hide-phone">
      <PageHead
        title="Execuções"
        subtitle="Cada mensagem que o time de agentes trabalhou, passo a passo"
        actions={
          <button className="btn btn-ghost" onClick={() => { haptic(); setCleaning(true); }}>
            <Icon name="trash" size={15} /> Limpar antigas
          </button>
        }
      />
      </div>

      <div className="card ex-kpis">
        <div>
          <small>Execuções · {periodShort}</small>
          <strong>{s ? s.total.toLocaleString("pt-BR") : "–"}</strong>
          <span>{s?.running ? `${s.running} rodando agora` : "nenhuma rodando agora"}</span>
        </div>
        <div>
          <small>Taxa de erro</small>
          <strong className={s?.errors ? "neg" : ""}>{s ? pct(s.errors, s.total) : "–"}</strong>
          <span>{s ? `${s.errors ? `${s.errors} com erro` : "nenhum erro"}${s.partial ? ` · ${s.partial} pela metade` : ""}` : " "}</span>
        </div>
        <div>
          <small>Duração média</small>
          <strong>{s ? dur(s.avg_ms) : "–"}</strong>
          <span>{s?.p95_ms ? `95% em até ${dur(s.p95_ms)}` : " "}</span>
        </div>
        <div>
          <small>Custo · {periodShort}</small>
          <strong>{s ? usdBR(s.cost_usd) : "–"}</strong>
          <span>{s?.total ? `${usdBR(s.cost_usd / s.total)}/execução · ${tok(s.tokens)} tokens` : " "}</span>
        </div>
      </div>

      <div className="ex-filters">
        <label className="ex-search">
          <Icon name="search" size={15} />
          <input value={search} onChange={(e) => set("search", e.target.value)} placeholder="Buscar" aria-label="Buscar" />
          {search && (
            <button aria-label="Limpar busca" onClick={() => set("search", "")}><Icon name="x" size={13} /></button>
          )}
        </label>
        <div className="ex-pills" role="tablist" aria-label="Status">
          {STATUSES.map(([v, label]) => (
            <button key={v} role="tab" aria-selected={status === v} className={status === v ? "active" : ""} onClick={() => { haptic(5); set("status", v); }}>
              {v && <span className={`dot ${v === "success" ? "dot-ok" : v === "error" ? "dot-err" : "dot-warn"}`} />}
              {label}
            </button>
          ))}
        </div>
        <select className="select ex-select" value={user} onChange={(e) => set("user", e.target.value)} aria-label="Pessoa">
          <option value="">Pessoas</option>
          {(s?.people ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name ?? phoneFmt(p.phone)}</option>)}
        </select>
        <select className="select ex-select" value={agent} onChange={(e) => set("agent", e.target.value)} aria-label="Agente">
          <option value="">Agentes</option>
          {(s?.agents ?? []).map((a: any) => {
            const m = agentMeta(a.agent);
            return <option key={a.agent} value={a.agent}>{m.persona ? `${m.persona} · ${m.name}` : m.name}</option>;
          })}
        </select>
        <select className="select ex-select" value={trigger} onChange={(e) => set("trigger", e.target.value)} aria-label="Gatilho">
          <option value="">Gatilhos</option>
          {Object.entries(TRIGGER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="select ex-select ex-period" value={since} onChange={(e) => set("since", e.target.value)} aria-label="Período">
          {PERIODS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        {filtered && (
          <button className="icon-btn ex-clear" onClick={clear} aria-label="Limpar filtros" title="Limpar filtros"><Icon name="x" size={15} /></button>
        )}
        <button className="icon-btn phone-only ex-trash" aria-label="Limpar antigas" onClick={() => { haptic(); setCleaning(true); }}><Icon name="trash" size={15} /></button>
      </div>

      <ErrorBox error={error} />

      <div className="card ex-list">
        <div className="ex-row ex-row-head" aria-hidden="true">
          <span />
          <small>Execução</small>
          <small className="ex-c-team">Time</small>
          <small className="ex-c-num">Duração</small>
          <small className="ex-c-num ex-c-tok">Tokens</small>
          <small className="ex-c-num">Custo</small>
          <small className="ex-c-when">Quando</small>
        </div>
        <div className="ex-scroll">
          {!data ? (
            <ListSkeleton />
          ) : !data.length ? (
            <div className="ex-empty">
              <span className="ex-empty-ico"><Icon name="activity" size={22} /></span>
              <strong>{filtered ? "Nada com esses filtros" : "Nenhuma execução ainda"}</strong>
              <p>{filtered ? "Tente outro período ou limpe a busca." : "Quando alguém mandar uma mensagem, cada passo do time aparece aqui."}</p>
              {filtered && <button className="btn" onClick={clear}>Limpar filtros</button>}
            </div>
          ) : (
            <>
              {groups.map(([label, items]) => (
                <Fragment key={label}>
                  <div className="ex-day"><small>{label}</small><small className="mono">{items.length}</small></div>
                  {items.map((e) => <ExecRow key={e.id} e={e} onOpen={() => { haptic(5); nav(`/executions/${e.id}`); }} />)}
                </Fragment>
              ))}
              {data.length >= limit && limit < 200 && (
                <div className="ex-more">
                  <button className="btn" onClick={() => { haptic(); setLimit((l) => Math.min(200, l + 60)); }}>Carregar mais</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {cleaning && (
        <Modal
          title="Limpar execuções antigas"
          icon={<Icon name="trash" size={16} />}
          onClose={() => setCleaning(false)}
          footer={
            <>
              <button className="btn" onClick={() => setCleaning(false)}>Cancelar</button>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  haptic(12);
                  await api("/api/executions?older_than_days=30", { method: "DELETE" });
                  setCleaning(false);
                  void reload();
                  void summary.reload();
                }}
              >
                Apagar
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>Apaga do log as execuções com mais de 30 dias. O custo por pessoa continua guardado nos relatórios.</p>
        </Modal>
      )}
    </div>
  );
}

function ExecRow({ e, onOpen }: { e: any; onOpen: () => void }) {
  const agents: string[] = (e.agents ?? []).filter(Boolean).sort((a: string, b: string) => (a === "cto" ? -1 : b === "cto" ? 1 : 0));
  const channel = channelOf(e);
  return (
    <button className={`ex-row ${e.status}`} onClick={onOpen}>
      <StatusIcon status={e.status} />
      <span className="ex-main">
        <span className={`ex-title ${e.content_purged ? "purged" : ""}`}>{executionTitle(e, 16)}</span>
        <span className="ex-meta">
          <span className="ex-who">{personOf(e) ?? "Sistema"}</span>
          {channel && <span className="ex-chan">{channel}</span>}
          <span className="ex-trig"><Icon name={TRIGGER_ICON[e.trigger] ?? "play"} size={11} /> {TRIGGER_LABEL[e.trigger] ?? e.trigger}</span>
          {e.model && <span className="mono ex-model">{shortModel(e.model)}</span>}
          <span className="ex-phone-nums mono">{dur(e.duration_ms)} · {usdBR(e.cost_usd)}</span>
        </span>
        {(e.status === "error" || e.status === "partial") && e.error && <span className={`ex-err-line ${e.status}`}>{firstWords(e.error.split("\n")[0], 20)}</span>}
      </span>
      <span className="ex-c-team ex-faces">
        {agents.slice(0, 4).map((a) => <AgentAvatar key={a} meta={agentMeta(a)} size={24} />)}
        {agents.length > 4 && <span className="ex-more-faces">+{agents.length - 4}</span>}
      </span>
      <span className="ex-c-num mono">{e.status === "running" ? "…" : dur(e.duration_ms)}</span>
      <span className="ex-c-num ex-c-tok mono">{tok(Number(e.tokens_in) + Number(e.tokens_out))}</span>
      <span className="ex-c-num mono">{usdBR(e.cost_usd)}</span>
      <span className="ex-c-when" title={fullWhen(e.started_at)}>
        <span>{agoShort(e.started_at)}</span>
        <small className="mono">{clock(e.started_at)}</small>
      </span>
    </button>
  );
}

function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Carregando">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="ex-row ex-skel">
          <span className="sk sk-circle" />
          <span className="ex-main"><span className="sk" style={{ width: `${60 - i * 4}%` }} /><span className="sk sk-sm" style={{ width: "34%" }} /></span>
          <span className="ex-c-team"><span className="sk" style={{ width: 48 }} /></span>
          <span className="ex-c-num"><span className="sk" /></span>
          <span className="ex-c-num ex-c-tok"><span className="sk" /></span>
          <span className="ex-c-num"><span className="sk" /></span>
          <span className="ex-c-when"><span className="sk" /></span>
        </div>
      ))}
    </div>
  );
}
