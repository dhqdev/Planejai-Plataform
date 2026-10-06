import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { ErrorBox, IntegrationIcon, Loading, Modal, PageHead } from "../components";
import { useApi } from "../hooks";

export function IntegrationsPage() {
  const { data, error, reload } = useApi<any>("/api/integrations");
  const [open, setOpen] = useState<any | null>(null);
  const [params, setParams] = useSearchParams();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const c = params.get("connected");
    if (c) setNotice({ ok: true, text: `${c === "mercadolivre" ? "Mercado Livre" : "Google"} conectado!` });
    if (params.get("error")) setNotice({ ok: false, text: params.get("error")! });
    if (params.size) setParams({}, { replace: true });
  }, [params, setParams]);

  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;
  const categories = [...new Set<string>(data.integrations.map((i: any) => i.category))];

  return (
    <div className="page">
      <PageHead title="Integrações" subtitle="Ferramentas que o seu agente pode usar. Credenciais ficam criptografadas no seu banco." />
      {notice && <div className={notice.ok ? "ok-box" : "error-box"} style={{ marginBottom: 14 }}>{notice.text}</div>}
      {categories.map((cat) => (
        <div key={cat} style={{ marginBottom: 20 }}>
          <h3 className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em" }}>{cat}</h3>
          <div className="card">
            {data.integrations
              .filter((i: any) => i.category === cat)
              .map((i: any) => (
                <div key={i.id} className="connector">
                  <IntegrationIcon icon={i.icon} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row">
                      <span className="name">{i.name}</span>
                      {i.connected && <span className="badge badge-ok"><span className="dot dot-ok" />Conectado{i.source === "env" ? " (via .env)" : ""}</span>}
                      {i.pendingOAuth && <span className="badge badge-warn">Falta autorizar</span>}
                      {!i.enabled && <span className="badge">Desativado</span>}
                    </div>
                    <div className="desc">{i.description}</div>
                  </div>
                  <button className={`btn ${i.connected ? "" : "btn-primary"}`} onClick={() => setOpen(i)}>
                    {i.connected ? "Gerenciar" : "Conectar"}
                  </button>
                </div>
              ))}
          </div>
        </div>
      ))}
      {open && <ConnectModal integration={open} onClose={() => { setOpen(null); void reload(); }} />}
    </div>
  );
}

const OAUTH_NAME: Record<string, string> = { google: "Google", mercadolivre: "Mercado Livre" };

function ConnectModal({ integration: i, onClose }: { integration: any; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const run = async (fn: () => Promise<any>) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      if (r?.message) setMsg({ ok: true, text: r.message });
      return r;
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={i.name}
      icon={<IntegrationIcon icon={i.icon} />}
      onClose={onClose}
      footer={
        <>
          {i.connected && i.source === "dashboard" && (
            <button className="btn btn-danger" disabled={busy} onClick={() => run(async () => { await api(`/api/integrations/${i.id}`, { method: "DELETE" }); onClose(); })}>
              Desconectar
            </button>
          )}
          {i.connected && (
            <button className="btn" disabled={busy} onClick={() => run(() => api(`/api/integrations/${i.id}/test`, { method: "POST" }))}>
              Testar
            </button>
          )}
          <span className="spacer" />
          {i.oauth && (i.connected || i.pendingOAuth) && (
            <button className="btn" disabled={busy} onClick={() => run(async () => { const r = await api(`/api/integrations/${i.id}/oauth/start`); window.location.href = r.url; })}>
              {i.connected ? "Reconectar" : "Conectar"} com {OAUTH_NAME[i.oauth]}
            </button>
          )}
          <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api(`/api/integrations/${i.id}`, { method: "PUT", json: values }))}>
            Salvar
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>{i.description}</p>
      {i.oauth && (
        <div className="field">
          <div className="help">
            Passo 1: salve as credenciais abaixo. Passo 2: clique em "Conectar com {OAUTH_NAME[i.oauth]}". Cadastre este endereço de redirecionamento no app do {OAUTH_NAME[i.oauth]}:
          </div>
          <code className="json" style={{ userSelect: "all" }}>{i.redirectUri}</code>
        </div>
      )}
      {i.fields.map((f: any) => (
        <div key={f.key} className="field">
          <label>{f.label}{f.required ? " *" : ""}</label>
          <input
            className="input"
            type={f.type === "password" ? "password" : "text"}
            placeholder={i.connected && f.type === "password" ? "•••••••• (salvo; deixe vazio para manter)" : f.placeholder}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
          />
          {f.help && <div className="help">{f.help}</div>}
        </div>
      ))}
      {i.docsUrl && (
        <a className="muted" href={i.docsUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
          Onde pegar as credenciais ↗
        </a>
      )}
      {msg && <div className={msg.ok ? "ok-box" : "error-box"} style={{ marginTop: 12 }}>{msg.text}</div>}
    </Modal>
  );
}
