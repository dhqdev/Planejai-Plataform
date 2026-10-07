import { useMemo, useState } from "react";
import { api } from "../api";
import { ErrorBox, Loading, PageHead } from "../components";
import { useApi } from "../hooks";

const price = (m: any) => (m ? `US$ ${m.promptPerM.toFixed(3)} / US$ ${m.completionPerM.toFixed(3)}` : "–");

export function ModelsPage() {
  const routes = useApi<any[]>("/api/models/routes");
  const catalog = useApi<any[]>("/api/models/catalog");
  const [filter, setFilter] = useState("");
  const [onlyTools, setOnlyTools] = useState(true);
  const byId = useMemo(() => new Map((catalog.data ?? []).map((m) => [m.id, m])), [catalog.data]);

  const filtered = useMemo(
    () =>
      (catalog.data ?? [])
        .filter((m) => (!onlyTools || m.tools) && (m.id + m.name).toLowerCase().includes(filter.toLowerCase()) && m.promptPerM >= 0)
        .sort((a, b) => a.promptPerM + a.completionPerM - (b.promptPerM + b.completionPerM))
        .slice(0, 80),
    [catalog.data, filter, onlyTools],
  );

  if (routes.error) return <div className="page"><ErrorBox error={routes.error} /></div>;
  if (!routes.data) return <Loading />;

  return (
    <div className="page">
      <PageHead title="Modelos" subtitle="Cada agente e tarefa usa o modelo mais barato que resolve. Preços do OpenRouter ao vivo (US$ por 1M tokens, entrada / saída)." />
      <datalist id="models">
        {(catalog.data ?? []).map((m) => <option key={m.id} value={m.id} />)}
      </datalist>
      <div className="card" style={{ marginBottom: 20 }}>
        <table className="table">
          <thead>
            <tr><th>Agente / tarefa</th><th>Modelo</th><th>Fallbacks</th><th>Temp.</th><th>Preço</th><th /></tr>
          </thead>
          <tbody>
            {routes.data.map((r) => (
              <RouteRow key={r.task} route={r} catalog={byId} onSaved={routes.reload} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="card card-pad">
        <div className="row" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Catálogo do OpenRouter</h3>
          <span className="spacer" />
          <label className="row muted"><input type="checkbox" checked={onlyTools} onChange={(e) => setOnlyTools(e.target.checked)} /> só com tool-calling</label>
          <input className="input" style={{ width: 260 }} placeholder="Buscar modelo" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <ErrorBox error={catalog.error} />
        <table className="table">
          <thead><tr><th>Modelo</th><th>Entrada / saída</th><th>Contexto</th><th>Entradas</th></tr></thead>
          <tbody>
            {filtered.map((m) => (
              <tr key={m.id}>
                <td><div className="mono">{m.id}</div><div className="muted" style={{ fontSize: 12 }}>{m.name}</div></td>
                <td className="mono">{price(m)}</td>
                <td className="muted">{Math.round(m.context / 1000)}k</td>
                <td className="muted">{m.inputModalities.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RouteRow({ route, catalog, onSaved }: { route: any; catalog: Map<string, any>; onSaved: () => void }) {
  const [model, setModel] = useState(route.model);
  const [fallbacks, setFallbacks] = useState((route.fallbacks ?? []).join(", "));
  const [temp, setTemp] = useState(route.temperature ?? "");
  const [err, setErr] = useState<string | null>(null);
  const dirty = model !== route.model || fallbacks !== (route.fallbacks ?? []).join(", ") || String(temp) !== String(route.temperature ?? "");
  const unknown = catalog.size > 0 && !catalog.has(model);

  return (
    <tr>
      <td style={{ maxWidth: 260 }}>
        <strong>{route.label}</strong>
        {route.overridden && <span className="badge badge-accent" style={{ marginLeft: 6 }}>personalizado</span>}
        <div className="muted" style={{ fontSize: 12 }}>{route.why}</div>
      </td>
      <td style={{ minWidth: 230 }}>
        <input className="input mono" list="models" value={model} onChange={(e) => setModel(e.target.value)} />
        {unknown && <div className="badge badge-warn" style={{ marginTop: 4 }}>não está no catálogo</div>}
        {err && <div className="error-box" style={{ marginTop: 4 }}>{err}</div>}
      </td>
      <td style={{ minWidth: 200 }}>
        <input className="input mono" value={fallbacks} onChange={(e) => setFallbacks(e.target.value)} placeholder="modelo-a, modelo-b" />
      </td>
      <td style={{ width: 80 }}>
        <input className="input" type="number" step="0.1" min="0" max="2" value={temp} onChange={(e) => setTemp(e.target.value)} />
      </td>
      <td className="mono" style={{ whiteSpace: "nowrap" }}>{price(catalog.get(model))}</td>
      <td style={{ whiteSpace: "nowrap" }}>
        <button
          className="btn btn-sm btn-primary"
          disabled={!dirty}
          onClick={async () => {
            try {
              await api(`/api/models/routes/${encodeURIComponent(route.task)}`, {
                method: "PUT",
                json: { model: model.trim(), fallbacks: fallbacks.split(",").map((s: string) => s.trim()).filter(Boolean), temperature: temp === "" ? null : Number(temp) },
              });
              setErr(null);
              onSaved();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Salvar
        </button>{" "}
        {route.overridden && (
          <button
            className="btn btn-sm"
            onClick={async () => {
              await api(`/api/models/routes/${encodeURIComponent(route.task)}`, { method: "DELETE" });
              setModel(route.default.model);
              setFallbacks(route.default.fallbacks.join(", "));
              onSaved();
            }}
          >
            Padrão
          </button>
        )}
      </td>
    </tr>
  );
}
