import { ago, api, brl, when } from "../api";
import { Empty, ErrorBox, Loading, PageHead } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";

/** O que o agente está vigiando sozinho (preço e notícias) e avisa no WhatsApp quando muda. */
export function WatchesPage() {
  const { data, error, reload } = useApi<any[]>("/api/watches", { poll: 60000 });
  if (!data) return error ? <div className="page"><ErrorBox error={error} /></div> : <Loading />;
  const active = data.filter((w) => w.active);
  const old = data.filter((w) => !w.active);

  const row = (w: any) => (
    <div key={w.id} className="line-item" style={{ padding: "12px 16px", opacity: w.active ? 1 : 0.55 }}>
      <Icon name={w.kind === "price" ? "target" : "globe"} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="ellipsis"><strong>{w.query}</strong></div>
        <div className="muted" style={{ fontSize: 12 }}>
          {w.kind === "price" ? "Preço" : "Notícias"}
          {w.target ? ` · avisa abaixo de ${brl(w.target)}` : ""}
          {w.best?.price ? ` · melhor até agora ${brl(w.best.price)}` : ""}
          {` · a cada ${w.every_hours}h`}
          {w.notified ? ` · ${w.notified} aviso(s)` : ""}
        </div>
      </div>
      <span className="muted hide-phone" style={{ fontSize: 12 }}>{w.active ? `próxima ${when(w.next_check_at)}` : `criado ${ago(w.created_at)}`}</span>
      {w.active && (
        <button className="icon-btn" aria-label="Parar" title="Parar de acompanhar" onClick={async () => { await api(`/api/watches/${w.id}`, { method: "DELETE" }); reload(); }}>
          <Icon name="x" size={16} />
        </button>
      )}
    </div>
  );

  return (
    <div className="page">
      <PageHead title="Acompanhamentos" subtitle="O agente confere sozinho e só manda mensagem quando aparece algo melhor. Peça no WhatsApp: &quot;fica de olho no preço do PS5&quot;." />
      <div className="card">
        {active.map(row)}
        {!active.length && <Empty>Nada sendo acompanhado agora.</Empty>}
      </div>
      {old.length > 0 && (
        <>
          <h3 style={{ marginTop: 22 }}>Encerrados</h3>
          <div className="card">{old.slice(0, 30).map(row)}</div>
        </>
      )}
    </div>
  );
}
