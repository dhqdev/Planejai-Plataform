import { useEffect, useState } from "react";
import { api } from "./api";
import { confirmDialog } from "./components";
import { useApi } from "./hooks";

interface Field {
  key: string;
  label: string;
  type: "text" | "password" | "url";
  required?: boolean;
  placeholder?: string;
  help?: string;
}

interface Item {
  id: string;
  name: string;
  description: string;
  docsUrl: string | null;
  oauth: boolean;
  available: boolean;
  fields: Field[];
  connected: boolean;
  label: string | null;
}

/**
 * Contas da própria pessoa (Google, Notion, GitHub, Linear, Slack). O assistente usa só as que ela conectou aqui;
 * as do dono ficam em Integrações e nunca valem para os clientes.
 */
export function MyIntegrations() {
  const { data, reload } = useApi<{ owner: boolean; integrations: Item[] }>("/api/me/integrations");
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // volta do Google: ?connected=google ou ?error=...
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("connected") === "google") setMsg("Google conectado.");
    else if (q.get("error")) setError(`Google: ${q.get("error")}`);
    if (q.has("connected") || q.has("error")) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  if (!data || data.owner || !data.integrations.length) return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const connect = (it: Item) =>
    run(async () => {
      if (it.oauth) {
        const r = await api<{ url: string }>(`/api/me/integrations/${it.id}/oauth`, { method: "POST" });
        window.location.href = r.url;
        return;
      }
      const r = await api<{ message: string }>(`/api/me/integrations/${it.id}`, { method: "PUT", json: form });
      setMsg(r.message);
      setOpen(null);
      setForm({});
      await reload();
    });
  const disconnect = async (it: Item) => {
    if (!(await confirmDialog({ title: `Desconectar ${it.name}?`, body: "O assistente para de usar essa conta na hora.", confirmLabel: "Desconectar", danger: true }))) return;
    await run(async () => {
      await api(`/api/me/integrations/${it.id}`, { method: "DELETE" });
      await reload();
    });
  };

  return (
    <div className="card card-pad conn-card">
      <h3>Contas conectadas</h3>
      <p className="muted conn-sub">
        Ligue suas contas para o assistente ler e-mails, marcar na sua agenda ou criar notas. Ele usa só o que você pedir, e só as contas que
        você conectou aqui.
      </p>
      {msg && <div className="ok-box" role="status" style={{ marginBottom: 10 }}>{msg}</div>}
      {error && <div className="error-box" style={{ marginBottom: 10 }}>{error}</div>}
      {data.integrations.map((it) => (
        <div key={it.id}>
          <div className="conn-row">
            <div className="conn-text">
              <strong>{it.name}</strong>
              <small className="muted">{it.connected ? `Conectado${it.label ? ` · ${it.label}` : ""}` : it.available ? it.description : "Ainda não disponível aqui"}</small>
            </div>
            {it.connected ? (
              <button className="btn btn-sm" disabled={busy} onClick={() => disconnect(it)}>Desconectar</button>
            ) : (
              it.available && (
                <button
                  className="btn btn-sm btn-brand"
                  disabled={busy}
                  aria-expanded={it.oauth ? undefined : open === it.id}
                  onClick={() => (it.oauth ? connect(it) : (setOpen(open === it.id ? null : it.id), setForm({})))}
                >
                  Conectar
                </button>
              )
            )}
          </div>
          {open === it.id && !it.connected && (
            <form
              style={{ margin: "4px 0 12px" }}
              onSubmit={(e) => {
                e.preventDefault();
                void connect(it);
              }}
            >
              {it.fields.map((f) => (
                <div className="field" key={f.key}>
                  <label htmlFor={`mi-${it.id}-${f.key}`}>{f.label}</label>
                  <input
                    id={`mi-${it.id}-${f.key}`}
                    className="input"
                    type={f.type === "password" ? "password" : "text"}
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="none"
                    placeholder={f.placeholder}
                    required={f.required}
                    value={form[f.key] ?? ""}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                  />
                  {f.help && <span className="help">{f.help}</span>}
                </div>
              ))}
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>{busy ? "Testando..." : "Testar e salvar"}</button>
                {it.docsUrl && (
                  <a className="muted" style={{ fontSize: 13 }} href={it.docsUrl} target="_blank" rel="noreferrer">Onde pego isso?</a>
                )}
              </div>
            </form>
          )}
        </div>
      ))}
    </div>
  );
}
