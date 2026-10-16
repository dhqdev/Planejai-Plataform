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
/** Link da oferta mais barata (o aviso de preço que era de Compras mora aqui): só http(s). */
const offerLink = (u?: string) => (u && /^https?:\/\//i.test(u) ? u : null);
const daysLeft = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));

const isWatchError = (summary?: string | null) => {
  if (!summary) return false;
  const s = summary.toLowerCase();
  return s.includes("nenhuma loja conectada") || s.includes("não está conectado") || s.includes("falta a busca") || s.includes("não consegui");
};

type TabMode = "active" | "ended";
type StatusFilter = "all" | "found" | "empty" | "error";
type SortMode = "newest" | "oldest" | "found_first";

/**
 * Acompanhamentos: o assistente olha sozinho por uma semana (ajustável) e manda no WhatsApp o que achou,
 * ou que não achou nada, a cada olhada. Dá para criar, ajustar, pausar, olhar agora e reativar por aqui.
 */
export function WatchesPage() {
  const { data, error, reload } = useApi<Watch[]>("/api/watches", { poll: 60000 });
  const [tab, setTab] = useState<TabMode>("active");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortOrder, setSortOrder] = useState<SortMode>("newest");
  const [editing, setEditing] = useState<Watch | "new" | null>(null);
  const [viewing, setViewing] = useState<Watch | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!data) return error ? <div className="page"><ErrorBox error={error} /></div> : <Loading />;

  const totalActive = data.filter((w) => w.active).length;
  const totalEnded = data.filter((w) => !w.active).length;
  const totalFound = data.filter((w) => w.last_result?.found).length;
  const totalErrors = data.filter((w) => isWatchError(w.last_result?.summary)).length;

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

  const listInTab = data.filter((w) => (tab === "active" ? w.active : !w.active));

  const filtered = listInTab.filter((w) => {
    const isErr = isWatchError(w.last_result?.summary);
    const isFound = Boolean(w.last_result?.found);
    if (statusFilter === "found") return isFound;
    if (statusFilter === "error") return isErr;
    if (statusFilter === "empty") return !isFound && !isErr;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortOrder === "found_first") {
      const aF = a.last_result?.found ? 1 : 0;
      const bF = b.last_result?.found ? 1 : 0;
      if (aF !== bF) return bF - aF;
    }
    const dateA = new Date(a.last_check_at ?? a.created_at).getTime();
    const dateB = new Date(b.last_check_at ?? b.created_at).getTime();
    return sortOrder === "oldest" ? dateA - dateB : dateB - dateA;
  });

  const card = (w: Watch) => {
    const isErr = isWatchError(w.last_result?.summary);
    const hasFound = Boolean(w.last_result?.found);
    const statusClass = !w.active ? "chip-ended" : w.paused ? "chip-paused" : "chip-active";
    const statusLabel = !w.active ? "Encerrado" : w.paused ? "Pausado" : "Ativo";

    let resultClass = "watch-result-neutral";
    if (hasFound) resultClass = "watch-result-found";
    else if (isErr) resultClass = "watch-result-warn";

    return (
      <div key={w.id} className={`watch-card ${!w.active ? "off" : ""} ${hasFound ? "watch-card-highlight" : ""}`}>
        <div className="watch-header">
          <div className="watch-head-left">
            <span className={`watch-ico ${w.kind === "price" ? "watch-ico-price" : "watch-ico-news"}`}>
              <Icon name={w.kind === "price" ? "target" : "globe"} size={18} />
            </span>
            <div className="watch-heading">
              <div className="watch-query-row">
                <strong className="watch-title" title={w.query}>{w.query}</strong>
              </div>
              <div className="watch-badges">
                <span className={`chip ${statusClass}`}>{statusLabel}</span>
                <span className="chip chip-neutral">{w.kind === "price" ? "Preço" : "Novidades"}</span>
                <span className="chip chip-neutral">a cada {w.every_hours}h</span>
                {w.active && (
                  <span className="chip chip-time">
                    {daysLeft(w.expires_at) ? `${daysLeft(w.expires_at)} dia(s) restando` : "termina hoje"}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {(w.target || w.best?.price) && (
          <div className="watch-prices-bar">
            {w.target && (
              <div className="watch-price-item">
                <span className="watch-price-label">Meta</span>
                <strong className="watch-price-val">{brl(Number(w.target))}</strong>
              </div>
            )}
            {w.best?.price != null && (
              <div className="watch-price-item">
                <span className="watch-price-label">Menor visto</span>
                <strong className="watch-price-val val-best">{brl(Number(w.best.price))}</strong>
              </div>
            )}
            {w.kind === "price" && offerLink(w.best?.link) && (
              <a className="watch-store-link" href={offerLink(w.best?.link)!} target="_blank" rel="noopener noreferrer">
                Ver na loja <Icon name="external" size={12} />
              </a>
            )}
          </div>
        )}

        <div className={`watch-result-box ${resultClass}`}>
          <div className="watch-result-head">
            <div className="watch-result-lead">
              <span className={`dot ${hasFound ? "dot-ok" : isErr ? "dot-warn" : ""}`} />
              <span className="watch-result-title">
                {hasFound ? "Novidade encontrada" : isErr ? "Atenção necessária" : "Última checagem"}
              </span>
            </div>
            {w.last_check_at && <span className="watch-result-time">{ago(w.last_check_at)}</span>}
          </div>
          <div className="watch-result-body">
            {w.last_result ? (
              <>
                <p className="watch-result-text">{w.last_result.summary}</p>
                {isErr && (
                  <a href="/integrations" className="watch-warn-link">
                    <Icon name="plug" size={13} /> Ir para Integrações
                  </a>
                )}
              </>
            ) : (
              <p className="watch-result-text muted">
                {w.active ? `Primeira olhada agendada ${when(w.next_check_at)}` : `Criado ${ago(w.created_at)}`}
              </p>
            )}
          </div>
          <div className="watch-result-foot">
            <span>{w.checks} olhada(s) realizada(s)</span>
            <span>{w.notify_mode === "always" ? "Avisa sempre" : "Avisa só quando achar"}</span>
          </div>
        </div>

        <div className="watch-actions-bar">
          {w.active ? (
            <>
              <button
                className="btn btn-sm"
                disabled={busy === w.id || w.paused}
                onClick={() => act(w, `/api/watches/${w.id}/check`, { method: "POST" })}
                title="Roda uma verificação imediata"
              >
                <Icon name="refresh" size={14} /> Olhar já
              </button>
              <button
                className="btn btn-sm"
                disabled={busy === w.id}
                onClick={() => act(w, `/api/watches/${w.id}`, { method: "PATCH", json: { paused: !w.paused } })}
              >
                <Icon name={w.paused ? "play" : "pause"} size={14} /> {w.paused ? "Retomar" : "Pausar"}
              </button>
              <button className="btn btn-sm" onClick={() => setEditing(w)}>
                <Icon name="edit" size={14} /> Ajustar
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => setViewing(w)}>
                <Icon name="eye" size={14} /> Detalhes
              </button>
              <span className="spacer" />
              <button
                className="icon-btn text-danger"
                title="Encerrar este acompanhamento"
                aria-label="Encerrar"
                onClick={async () => {
                  if (await confirmDialog({ title: "Parar de acompanhar?", body: `Deseja parar de acompanhar "${w.query}"?`, confirmLabel: "Parar", danger: true })) {
                    void act(w, `/api/watches/${w.id}`, { method: "DELETE" });
                  }
                }}
              >
                <Icon name="trash" size={15} />
              </button>
            </>
          ) : (
            <>
              <button
                className="btn btn-sm btn-primary-soft"
                disabled={busy === w.id}
                onClick={() => act(w, `/api/watches/${w.id}`, { method: "PATCH", json: { reactivate: true } })}
              >
                <Icon name="refresh" size={14} /> Acompanhar mais 7 dias
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => setViewing(w)}>
                <Icon name="eye" size={14} /> Ver detalhes
              </button>
              <span className="spacer" />
              <button
                className="icon-btn text-muted"
                title="Remover acompanhamento"
                aria-label="Excluir"
                onClick={async () => {
                  if (await confirmDialog({ title: "Remover do histórico?", body: `Remover o acompanhamento de "${w.query}"?`, confirmLabel: "Remover", danger: true })) {
                    void act(w, `/api/watches/${w.id}`, { method: "DELETE" });
                  }
                }}
              >
                <Icon name="trash" size={15} />
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="page watches-page">
      <PageHead
        title="Acompanhamentos"
        subtitle="O assistente olha sozinho por 7 dias e te conta no WhatsApp o que achou. Dá para pedir aqui ou no chat direto."
        actions={<button className="btn btn-brand" onClick={() => setEditing("new")}><Icon name="plus" size={16} /> Novo</button>}
      />

      <div className="watches-stats-grid">
        <div className="watch-stat-card">
          <span className="watch-stat-num text-brand">{totalActive}</span>
          <span className="watch-stat-label">Ativos agora</span>
        </div>
        <div className="watch-stat-card">
          <span className="watch-stat-num text-success">{totalFound}</span>
          <span className="watch-stat-label">Com novidade</span>
        </div>
        <div className="watch-stat-card">
          <span className="watch-stat-num text-warn">{totalErrors}</span>
          <span className="watch-stat-label">Precisam de atenção</span>
        </div>
        <div className="watch-stat-card">
          <span className="watch-stat-num text-muted">{totalEnded}</span>
          <span className="watch-stat-label">Encerrados</span>
        </div>
      </div>

      <div className="watches-controls-bar">
        <div className="watches-nav-tabs">
          <button
            className={`watches-nav-tab ${tab === "active" ? "active" : ""}`}
            onClick={() => setTab("active")}
          >
            Ativos <span className="tab-badge">{totalActive}</span>
          </button>
          <button
            className={`watches-nav-tab ${tab === "ended" ? "active" : ""}`}
            onClick={() => setTab("ended")}
          >
            Encerrados <span className="tab-badge">{totalEnded}</span>
          </button>
        </div>

        <div className="watches-filter-group">
          <div className="watches-select-wrap">
            <label htmlFor="watch-filter-status" className="watches-control-label">Status:</label>
            <select
              id="watch-filter-status"
              className="select select-sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            >
              <option value="all">Todos</option>
              <option value="found">Com novidade</option>
              <option value="empty">Sem novidade</option>
              <option value="error">Com erro / lojas</option>
            </select>
          </div>

          <div className="watches-select-wrap">
            <label htmlFor="watch-sort-order" className="watches-control-label">Ordenar por:</label>
            <select
              id="watch-sort-order"
              className="select select-sm"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as SortMode)}
            >
              <option value="newest">Mais recente</option>
              <option value="oldest">Mais antigo</option>
              <option value="found_first">Novidades primeiro</option>
            </select>
          </div>
        </div>
      </div>

      {sorted.length > 0 ? (
        <div className="watch-list-grid">
          {sorted.map(card)}
        </div>
      ) : (
        <div className="card watch-empty-card">
          <div className="watch-empty-icon">
            <Icon name="eye" size={34} />
          </div>
          <h3>{tab === "active" ? "Nenhum acompanhamento ativo por aqui" : "Nenhum acompanhamento encerrado"}</h3>
          <p className="watch-empty-text">
            Você pode criar um novo por aqui ou falar direto no WhatsApp: <br />
            <span className="watch-phrase-chip">"fica de olho no preço do PS5"</span> ou <span className="watch-phrase-chip">"acompanha notícias de tecnologia"</span>
          </p>
          {tab === "active" && (
            <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={() => setEditing("new")}>
              <Icon name="plus" size={16} /> Criar acompanhamento
            </button>
          )}
        </div>
      )}

      {viewing && (
        <WatchDetailsModal
          watch={viewing}
          onClose={() => setViewing(null)}
          onReactivate={() => {
            const target = viewing;
            setViewing(null);
            void act(target, `/api/watches/${target.id}`, { method: "PATCH", json: { reactivate: true } });
          }}
        />
      )}

      {editing && <WatchForm initial={editing === "new" ? null : editing} onClose={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

function WatchDetailsModal({ watch, onClose, onReactivate }: { watch: Watch; onClose: () => void; onReactivate: () => void }) {
  const hasFound = Boolean(watch.last_result?.found);
  const isErr = isWatchError(watch.last_result?.summary);

  return (
    <Modal
      title="Detalhes do acompanhamento"
      icon={<Icon name="eye" />}
      onClose={onClose}
      footer={
        <>
          {!watch.active && (
            <button className="btn btn-primary-soft" onClick={onReactivate}>
              <Icon name="refresh" size={14} /> Acompanhar mais 7 dias
            </button>
          )}
          <button className="btn btn-secondary" onClick={onClose}>Fechar</button>
        </>
      }
    >
      <div className="watch-modal-details">
        <div className="watch-modal-heading">
          <h3>{watch.query}</h3>
          <div className="watch-badges" style={{ marginTop: 6 }}>
            <span className={`chip ${watch.active ? (watch.paused ? "chip-paused" : "chip-active") : "chip-ended"}`}>
              {watch.active ? (watch.paused ? "Pausado" : "Ativo") : "Encerrado"}
            </span>
            <span className="chip chip-neutral">{watch.kind === "price" ? "Monitor de Preço" : "Novidades & Notícias"}</span>
            <span className="chip chip-neutral">A cada {watch.every_hours} horas</span>
          </div>
        </div>

        <div className="watch-modal-section">
          <h4>Último resultado</h4>
          <div className={`watch-result-box ${hasFound ? "watch-result-found" : isErr ? "watch-result-warn" : "watch-result-neutral"}`}>
            <div className="watch-result-head">
              <span className="watch-result-title">{hasFound ? "Encontrou novidade" : isErr ? "Aviso" : "Status"}</span>
              {watch.last_check_at && <span className="watch-result-time">{ago(watch.last_check_at)}</span>}
            </div>
            <p className="watch-result-text" style={{ marginTop: 8 }}>
              {watch.last_result?.summary ?? "Ainda não foi realizada nenhuma checagem."}
            </p>
            {isErr && (
              <div style={{ marginTop: 8 }}>
                <a href="/integrations" className="watch-warn-link">
                  <Icon name="plug" size={13} /> Configurar integrações
                </a>
              </div>
            )}
          </div>
        </div>

        {(watch.target || watch.best) && (
          <div className="watch-modal-section">
            <h4>Preços registrados</h4>
            <div className="watch-prices-bar">
              {watch.target && (
                <div className="watch-price-item">
                  <span className="watch-price-label">Sua meta</span>
                  <strong className="watch-price-val">{brl(Number(watch.target))}</strong>
                </div>
              )}
              {watch.best?.price != null && (
                <div className="watch-price-item">
                  <span className="watch-price-label">Melhor preço visto</span>
                  <strong className="watch-price-val val-best">{brl(Number(watch.best.price))}</strong>
                </div>
              )}
            </div>
            {watch.best?.title && (
              <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                Oferta: {watch.best.title}
              </p>
            )}
            {offerLink(watch.best?.link) && (
              <a className="watch-store-link" style={{ marginTop: 6, display: "inline-flex" }} href={offerLink(watch.best?.link)!} target="_blank" rel="noopener noreferrer">
                Ver link da oferta <Icon name="external" size={13} />
              </a>
            )}
          </div>
        )}

        <div className="watch-modal-section">
          <h4>Informações de execução</h4>
          <div className="watch-info-grid">
            <div>
              <span className="muted">Criado em:</span>
              <div>{when(watch.created_at)}</div>
            </div>
            <div>
              <span className="muted">Expira em:</span>
              <div>{when(watch.expires_at)}</div>
            </div>
            <div>
              <span className="muted">Total de olhadas:</span>
              <div>{watch.checks} checagens</div>
            </div>
            <div>
              <span className="muted">Notificações enviadas:</span>
              <div>{watch.notified} mensagens</div>
            </div>
            <div>
              <span className="muted">Próxima checagem:</span>
              <div>{watch.active && !watch.paused ? when(watch.next_check_at) : "Em pausa / encerrado"}</div>
            </div>
            <div>
              <span className="muted">Modo de aviso:</span>
              <div>{watch.notify_mode === "always" ? "A cada checagem" : "Apenas quando houver novidade"}</div>
            </div>
          </div>
        </div>
      </div>
    </Modal>
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
