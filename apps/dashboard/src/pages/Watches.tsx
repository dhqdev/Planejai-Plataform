import { useState } from "react";
import { ago, api, brl, when } from "../api";
import { Empty, ErrorBox, Loading, Modal, PageHead, alertDialog, confirmDialog } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";

type Watch = {
  id: string;
  kind: "price" | "news";
  query: string;
  target: string | null;
  best: { price?: number; title?: string; link?: string } | null;
  every_hours: number;
  next_check_at: string;
  expires_at: string;
  created_at: string;
  notified: number;
  checks: number;
  active: boolean;
  paused: boolean;
  notify_mode: "always" | "changes";
  last_check_at: string | null;
  last_result: { found: boolean; summary: string } | null;
};

const HOURS = [3, 6, 8, 12, 24, 48];
const DAYS = [1, 3, 7, 14, 30];
const daysLeft = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));

/**
 * Acompanhamentos: o agente olha sozinho por uma semana (ajustável) e manda no WhatsApp o que achou,
 * ou que não achou nada, a cada olhada. Dá para criar, ajustar, pausar, olhar agora e reativar por aqui.
 */
export function WatchesPage() {
  const { data, error, reload } = useApi<Watch[]>("/api/watches", { poll: 60000 });
  const [editing, setEditing] = useState<Watch | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!data) return error ? <div className="page"><ErrorBox error={error} /></div> : <Loading />;
  const active = data.filter((w) => w.active);
  const old = data.filter((w) => !w.active);

  const act = async (w: Watch, path: string, init: Parameters<typeof api>[1]) => {
    setBusy(w.id);
    try {
      await api(path, init);
      haptic(8);
    } catch (e) {
      void alertDialog("Não deu certo", (e as Error).message);
    } finally {
      setBusy(null);
      reload();
    }
  };

  const card = (w: Watch) => {
    const status = !w.active ? "Encerrado" : w.paused ? "Pausado" : "Ativo";
    return (
      <div key={w.id} className={`watch-card${w.active && !w.paused ? "" : " off"}`}>
        <div className="watch-top">
          <span className="watch-ico"><Icon name={w.kind === "price" ? "target" : "globe"} /></span>
          <div className="watch-main">
            <strong className="watch-title">{w.query}</strong>
            <div className="watch-meta">
              <span className={`chip chip-${status === "Ativo" ? "on" : "off"}`}>{status}</span>
              <span>{w.kind === "price" ? "Preço" : "Novidades"}</span>
              <span>a cada {w.every_hours}h</span>
              {w.active && <span>{daysLeft(w.expires_at) ? `termina em ${daysLeft(w.expires_at)} dia(s)` : "termina hoje"}</span>}
              <span>{w.notify_mode === "always" ? "avisa a cada olhada" : "só avisa quando achar"}</span>
            </div>
          </div>
        </div>
        {(w.target || w.best?.price) && (
          <div className="watch-meta">
            {w.target && <span>meta {brl(Number(w.target))}</span>}
            {w.best?.price != null && <span>menor até agora {brl(Number(w.best.price))}</span>}
          </div>
        )}
        <div className="watch-last">
          {w.last_result ? (
            <>
              <span className={`dot ${w.last_result.found ? "dot-ok" : ""}`} />
              <span>
                {w.last_result.found ? "Achou: " : "Última olhada: "}
                {w.last_result.summary}
                <span className="muted"> · {ago(w.last_check_at!)} · {w.checks} olhada(s)</span>
              </span>
            </>
          ) : (
            <span className="muted">{w.active ? `Primeira olhada ${when(w.next_check_at)}` : `Criado ${ago(w.created_at)}`}</span>
          )}
        </div>
        <div className="watch-actions">
          {w.active ? (
            <>
              <button className="btn btn-sm" disabled={busy === w.id || w.paused} onClick={() => act(w, `/api/watches/${w.id}/check`, { method: "POST" })}>
                <Icon name="refresh" size={15} /> Olhar já
              </button>
              <button className="btn btn-sm" disabled={busy === w.id} onClick={() => act(w, `/api/watches/${w.id}`, { method: "PATCH", json: { paused: !w.paused } })}>
                <Icon name={w.paused ? "play" : "pause"} size={15} /> {w.paused ? "Retomar" : "Pausar"}
              </button>
              <button className="btn btn-sm" onClick={() => setEditing(w)}><Icon name="edit" size={15} /> Ajustar</button>
              <span className="spacer" />
              <button
                className="icon-btn"
                aria-label="Parar de acompanhar"
                onClick={async () => {
                  if (await confirmDialog({ title: "Parar de acompanhar?", body: w.query, confirmLabel: "Parar", danger: true })) void act(w, `/api/watches/${w.id}`, { method: "DELETE" });
                }}
              >
                <Icon name="trash" size={16} />
              </button>
            </>
          ) : (
            <button className="btn btn-sm" disabled={busy === w.id} onClick={() => act(w, `/api/watches/${w.id}`, { method: "PATCH", json: { reactivate: true } })}>
              <Icon name="refresh" size={15} /> Acompanhar mais 7 dias
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="page">
      <PageHead
        title="Acompanhamentos"
        subtitle="O assistente olha sozinho por 7 dias e te conta no WhatsApp o que achou, ou que não achou nada. Também dá para pedir lá: &quot;fica de olho no preço do PS5&quot;."
        actions={<button className="btn btn-brand" onClick={() => setEditing("new")}><Icon name="plus" size={16} /> Novo</button>}
      />
      <div className="watch-list">
        {active.map(card)}
        {!active.length && <div className="card"><Empty>Nada sendo acompanhado agora. Toque em Novo ou peça no WhatsApp.</Empty></div>}
      </div>
      {old.length > 0 && (
        <>
          <h3 style={{ marginTop: 22 }}>Encerrados</h3>
          <div className="watch-list">{old.slice(0, 20).map(card)}</div>
        </>
      )}
      {editing && <WatchForm initial={editing === "new" ? null : editing} onClose={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

function WatchForm({ initial, onClose }: { initial: Watch | null; onClose: () => void }) {
  const [f, setF] = useState({
    kind: initial?.kind ?? "news",
    query: initial?.query ?? "",
    target: initial?.target ? String(initial.target).replace(".", ",") : "",
    every_hours: initial?.every_hours ?? 12,
    days: initial ? Math.max(1, daysLeft(initial.expires_at)) : 7,
    notify_mode: initial?.notify_mode ?? "always",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    const target = f.target.trim() ? Number(f.target.replace(/\./g, "").replace(",", ".")) : null;
    const body = { query: f.query, target, every_hours: f.every_hours, days: f.days, notify_mode: f.notify_mode };
    try {
      if (initial) await api(`/api/watches/${initial.id}`, { method: "PATCH", json: body });
      else await api("/api/watches", { method: "POST", json: { ...body, kind: f.kind } });
      haptic(10);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={initial ? "Ajustar acompanhamento" : "Novo acompanhamento"}
      icon={<Icon name="eye" />}
      onClose={onClose}
      footer={<button className="btn btn-primary" disabled={busy || !f.query.trim()} onClick={save}>{busy ? "Salvando…" : "Salvar"}</button>}
    >
      <ErrorBox error={error} />
      {!initial && (
        <div className="tabs">
          <button className={f.kind === "news" ? "active" : ""} aria-pressed={f.kind === "news"} onClick={() => setF({ ...f, kind: "news", every_hours: 12 })}>Novidades</button>
          <button className={f.kind === "price" ? "active" : ""} aria-pressed={f.kind === "price"} onClick={() => setF({ ...f, kind: "price", every_hours: 8 })}>Preço</button>
        </div>
      )}
      <div className="field">
        <label htmlFor="wt-query">{f.kind === "price" ? "Produto" : "O que acompanhar"}</label>
        <input id="wt-query" className="input" autoComplete="off" value={f.query} onChange={(e) => setF({ ...f, query: e.target.value })}
          placeholder={f.kind === "price" ? "iPhone 16 128GB" : "vagas de estágio em Campinas"} />
      </div>
      {f.kind === "price" && (
        <div className="field">
          <label htmlFor="wt-target">Avisar abaixo de (R$, opcional)</label>
          <input id="wt-target" className="input" inputMode="decimal" autoComplete="off" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} placeholder="4500" />
        </div>
      )}
      <div className="grid grid-2" style={{ gap: 10 }}>
        <div className="field">
          <label htmlFor="wt-hours">Olhar a cada</label>
          <select id="wt-hours" className="select" value={f.every_hours} onChange={(e) => setF({ ...f, every_hours: Number(e.target.value) })}>
            {HOURS.filter((h) => f.kind === "price" || h >= 6).map((h) => <option key={h} value={h}>{h} horas</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="wt-days">{initial ? "Por mais" : "Durante"}</label>
          <select id="wt-days" className="select" value={f.days} onChange={(e) => setF({ ...f, days: Number(e.target.value) })}>
            {[...new Set([...DAYS, f.days])].sort((a, b) => a - b).map((d) => <option key={d} value={d}>{d === 1 ? "1 dia" : `${d} dias`}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="wt-notify">Mensagens no WhatsApp</label>
        <select id="wt-notify" className="select" value={f.notify_mode} onChange={(e) => setF({ ...f, notify_mode: e.target.value as Watch["notify_mode"] })}>
          <option value="always">A cada olhada, achando ou não</option>
          <option value="changes">Só quando achar algo</option>
        </select>
      </div>
    </Modal>
  );
}
