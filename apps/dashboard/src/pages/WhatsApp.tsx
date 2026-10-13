import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ago, api, phoneFmt } from "../api";
import { ErrorBox, Loading, PageHead, confirmDialog } from "../components";
import { useApi } from "../hooks";

const LABEL: Record<string, [string, string]> = {
  connected: ["badge-ok", "Conectado"],
  connecting: ["badge-warn", "Conectando…"],
  reconnecting: ["badge-warn", "Reconectando…"],
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
          s.status === "connected" || s.status === "reconnecting" ? (
            <>
              <button className="btn" disabled={busy} onClick={() => act("/api/whatsapp/restart")}>Reiniciar conexão</button>
              <button className="btn btn-danger" disabled={busy} onClick={async () => {
                  const ok = await confirmDialog({
                    title: "Desconectar este número?",
                    body: "O assistente para de receber e responder mensagens até você ler um QR code novo.",
                    confirmLabel: "Desconectar",
                    danger: true,
                  });
                  if (ok) void act("/api/whatsapp/logout");
                }}>Desconectar</button>
            </>
          ) : null
        }
      />
      <div className="grid grid-2">
        <div className="card card-pad">
          <div className="row row-wrap" style={{ marginBottom: 14 }}>
            <span className={`badge ${cls}`}>{label}</span>
            {s.listening ? (
              <span className="badge badge-ok"><span className="dot dot-ok" /> escutando agora</span>
            ) : (
              <span className="badge badge-err">worker sem sinal{s.heartbeat_at ? ` há ${ago(s.heartbeat_at).replace(/^há /, "")}` : ""}</span>
            )}
          </div>
          <div className="muted" style={{ fontSize: 13, marginTop: -8, marginBottom: 12 }}>
            Última mensagem recebida: {s.last_message_at ? ago(s.last_message_at) : "nenhuma ainda"}
          </div>
          {!s.listening && (
            <div className="notice notice-warn" style={{ marginBottom: 12 }}>
              Nenhum processo está segurando a conexão agora, então as mensagens não chegam. Confira se o serviço <code>worker</code> da stack está rodando; quando ele sobe, assume a conexão sozinho em até 45 segundos.
            </div>
          )}

          {s.status === "connected" && (
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, overflowWrap: "anywhere" }}>{s.name || "WhatsApp"}</div>
              <div className="mono">{s.phone ? phoneFmt(s.phone) : ""}</div>
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

          {s.status === "reconnecting" && (
            <div>
              <div className="notice notice-warn" style={{ marginBottom: 12 }}>
                A conexão caiu{s.down_since ? ` ${ago(s.down_since)}` : ""} e está voltando sozinha, com a sessão salva (não precisa de QR code).
                Mensagens enviadas nesse meio-tempo esperam a conexão voltar.
              </div>
              {s.last_error && <p className="muted" style={{ fontSize: 12 }}>Motivo: {s.last_error}</p>}
            </div>
          )}

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
                <div className="row row-wrap">
                  <input className="input" style={{ flex: "1 1 220px", width: "auto" }} type="tel" name="tel" inputMode="tel" autoComplete="tel" aria-label="Número com DDI" placeholder="Número com DDI, ex.: 5519999999999" value={phone} onChange={(e) => setPhone(e.target.value)} />
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
      {s.status === "connected" && <ProfileCard currentName={s.name ?? ""} />}
    </div>
  );
}

/** Foto do perfil pronta para o WhatsApp: quadrada 640x640, recortada no centro, JPEG (sem biblioteca no servidor). */
async function toProfileJpeg(src: string) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 640;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 640, 640);
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 640, 640);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** Perfil do número do assistente: nome, recado e foto. Perfil completo passa confiança e ajuda contra bloqueio. */
function ProfileCard({ currentName }: { currentName: string }) {
  const [name, setName] = useState(currentName);
  const [status, setStatus] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const pick = async (src: string) => {
    setErr(null);
    try {
      setPhoto(await toProfileJpeg(src));
    } catch {
      setErr("Não consegui abrir essa imagem.");
    }
  };
  const save = async () => {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const body: Record<string, string> = {};
      if (name.trim() && name.trim() !== currentName) body.name = name.trim();
      if (status.trim()) body.status = status.trim();
      if (photo) body.picture = photo.split(",")[1]!;
      await api("/api/whatsapp/profile", { method: "POST", json: body });
      setSaved(true);
      setPhoto(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const changed = (name.trim() && name.trim() !== currentName) || status.trim() || photo;

  return (
    <div className="card card-pad" style={{ marginTop: 16 }}>
      <h3>Perfil do número</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Nome, recado e foto que as pessoas veem. Um perfil completo passa mais confiança para quem recebe a primeira mensagem e ajuda o WhatsApp a não bloquear o número.
      </p>
      <div className="row row-wrap" style={{ alignItems: "flex-start", gap: 16 }}>
        <div style={{ flex: "1 1 260px" }}>
          <div className="field">
            <label htmlFor="wa-name">Nome</label>
            <input id="wa-name" className="input" maxLength={25} value={name} placeholder="Ex.: Planejai" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="wa-status">Recado</label>
            <input id="wa-status" className="input" maxLength={139} value={status} placeholder="Ex.: Assistente virtual do Planejai" onChange={(e) => setStatus(e.target.value)} />
          </div>
        </div>
        <div style={{ flex: "0 1 auto" }}>
          <div className="field">
            <label>Foto</label>
            <div className="row row-wrap" style={{ gap: 10 }}>
              {photo && <img src={photo} alt="Nova foto do perfil" style={{ width: 64, height: 64, borderRadius: "50%", objectFit: "cover" }} />}
              <button className="btn" type="button" disabled={busy} onClick={() => file.current?.click()}>Escolher foto</button>
              <button className="btn" type="button" disabled={busy} onClick={() => pick("/icons/icon-512.png")}>Usar o ícone do Planejai</button>
            </div>
            <input
              ref={file}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void pick(URL.createObjectURL(f));
                e.target.value = "";
              }}
            />
          </div>
        </div>
      </div>
      <div className="row row-wrap" style={{ gap: 12 }}>
        <button className="btn btn-primary" disabled={busy || !changed} onClick={save}>{busy ? "Salvando…" : "Salvar perfil"}</button>
        {saved && <span className="muted">Perfil atualizado no WhatsApp.</span>}
      </div>
      <ErrorBox error={err} />
    </div>
  );
}
