import { useState } from "react";
import { Link } from "react-router-dom";
import { ago, api } from "../api";
import { ErrorBox, Loading, PageHead } from "../components";
import { useApi } from "../hooks";

const LABEL: Record<string, [string, string]> = {
  connected: ["badge-ok", "Conectado"],
  connecting: ["badge-warn", "Conectando…"],
  qr: ["badge-info", "Aguardando leitura do QR code"],
  pairing: ["badge-info", "Aguardando o código no celular"],
  disconnected: ["badge-err", "Desconectado"],
};

/** Conexão própria do WhatsApp (Baileys): QR code ou código de pareamento, como no WhatsApp Web. */
export function WhatsAppPage() {
  const { data, error, reload } = useApi<any>("/api/whatsapp", { poll: 2000 });
  const [mode, setMode] = useState<"qr" | "code">("qr");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;

  if (data.provider !== "baileys") {
    return (
      <div className="page">
        <PageHead title="WhatsApp" />
        <div className="card card-pad">
          Este servidor usa <strong>{data.provider === "cloud" ? "a WhatsApp Cloud API" : data.provider === "evolution" ? "a Evolution API" : "nenhum canal"}</strong>.
          Para conectar um número direto por QR code, defina <code>WHATSAPP_PROVIDER=baileys</code> na stack. Detalhes em <Link to="/settings" style={{ color: "var(--accent)" }}>Configurações</Link>.
        </div>
      </div>
    );
  }

  const s = data.session ?? { status: "disconnected" };
  const [cls, label] = LABEL[s.status] ?? ["", s.status];
  const act = async (path: string, json?: unknown) => {
    setBusy(true);
    setErr(null);
    try {
      await api(path, { method: "POST", json: json ?? {} });
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHead
        title="WhatsApp"
        subtitle="Conexão própria do agente com o WhatsApp, sem serviço externo. Use um número só para o assistente."
        actions={
          s.status === "connected" ? (
            <>
              <button className="btn" disabled={busy} onClick={() => act("/api/whatsapp/restart")}>Reiniciar conexão</button>
              <button className="btn btn-danger" disabled={busy} onClick={() => confirm("Desconectar este número do agente?") && act("/api/whatsapp/logout")}>Desconectar</button>
            </>
          ) : null
        }
      />
      <div className="grid grid-2">
        <div className="card card-pad">
          <div className="row" style={{ marginBottom: 14 }}>
            <span className={`badge ${cls}`}>{label}</span>
            <span className="muted" style={{ fontSize: 12 }}>atualizado {ago(s.updated_at)}</span>
          </div>

          {s.status === "connected" && (
            <div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{s.name ?? "WhatsApp"}</div>
              <div className="mono">+{s.phone}</div>
              <p className="muted">Mensagens que chegarem neste número vão para o time de agentes. Pessoas novas aparecem em <Link to="/people" style={{ color: "var(--accent)" }}>Pessoas</Link> para você aprovar.</p>
            </div>
          )}

          {s.status === "qr" && s.qr && (
            <div style={{ textAlign: "center" }}>
              <img src={s.qr} alt="QR code do WhatsApp" style={{ width: 280, maxWidth: "100%", background: "#fff", padding: 8, borderRadius: 12 }} />
              <p className="muted">O QR muda a cada ~20 segundos; esta tela atualiza sozinha.</p>
            </div>
          )}

          {s.status === "pairing" && s.pairing_code && (
            <div style={{ textAlign: "center" }}>
              <div className="mono" style={{ fontSize: 34, letterSpacing: 6, fontWeight: 700, margin: "18px 0" }}>
                {s.pairing_code.slice(0, 4)}-{s.pairing_code.slice(4)}
              </div>
              <p className="muted">Digite este código no celular.</p>
            </div>
          )}

          {s.status === "connecting" && <p className="muted">Abrindo conexão com o WhatsApp…</p>}

          {(s.status === "disconnected" || s.status === "qr" || s.status === "pairing") && (
            <div style={{ marginTop: 12 }}>
              {s.last_error && <div className="error-box" style={{ marginBottom: 12 }}>{s.last_error}</div>}
              <div className="tabs">
                <button className={mode === "qr" ? "active" : ""} onClick={() => setMode("qr")}>QR code</button>
                <button className={mode === "code" ? "active" : ""} onClick={() => setMode("code")}>Código de pareamento</button>
              </div>
              {mode === "qr" ? (
                <button className="btn btn-primary" disabled={busy} onClick={() => act("/api/whatsapp/connect")}>
                  {s.status === "qr" ? "Gerar novo QR code" : "Gerar QR code"}
                </button>
              ) : (
                <div className="row">
                  <input className="input" placeholder="Número com DDI, ex.: 5519999999999" value={phone} onChange={(e) => setPhone(e.target.value)} />
                  <button className="btn btn-primary" disabled={busy || phone.replace(/\D/g, "").length < 10} onClick={() => act("/api/whatsapp/connect", { phone })}>
                    Gerar código
                  </button>
                </div>
              )}
            </div>
          )}
          <ErrorBox error={err} />
        </div>

        <div className="card card-pad">
          <h3>Como conectar</h3>
          <ol style={{ paddingLeft: 18, margin: 0, lineHeight: 1.8 }}>
            <li>No celular do número do assistente, abra o WhatsApp.</li>
            <li>Toque em <strong>⋮ / Configurações</strong> e depois em <strong>Dispositivos conectados</strong>.</li>
            <li>Toque em <strong>Conectar um dispositivo</strong>.</li>
            <li>Leia o QR code ao lado, ou toque em <em>Conectar com número de telefone</em> e digite o código.</li>
          </ol>
          <p className="muted" style={{ marginTop: 14 }}>
            A sessão fica salva no banco da stack, então sobrevive a redeploys. Se o celular remover o dispositivo, gere um QR novo aqui.
            Prefira um número dedicado: se for o seu número pessoal, o agente vai receber as mensagens dos seus contatos (as de quem não está aprovado ficam só registradas).
          </p>
        </div>
      </div>
    </div>
  );
}
