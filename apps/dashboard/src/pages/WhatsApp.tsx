import { useState } from "react";
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
  const { data, error, reload } = useApi<any>("/api/whatsapp", { poll: 2000, live: ["wa_sessions"] });
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
      {s.status === "connected" && <StatusCard />}
    </div>
  );
}

interface StatusPost {
  id: string;
  kind: "imagem" | "blog";
  caption: string;
  status: "rascunho" | "postado" | "falhou";
  recipients: number | null;
  error: string | null;
  posted_at: string | null;
  created_at: string;
}
interface StatusData {
  settings: { enabled: boolean; everyDays: number; hour: number; blogEvery: number; lastAt?: string };
  posts: StatusPost[];
  audience: number;
  monthlyUsd: number;
}

const usd = (v: number) => `US$ ${v.toFixed(2).replace(".", ",")}`;

/**
 * Status do WhatsApp do número: o Bolinho em cenas divertidas (rota Imagens, barata) ou a capa de um post do blog.
 * Rascunho primeiro; o automático só posta depois que o dono liga.
 */
function StatusCard() {
  const { data, error, reload } = useApi<StatusData>("/api/whatsapp/status-posts");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});

  if (error) return <div className="card card-pad" style={{ marginTop: 16 }}><ErrorBox error={error} /></div>;
  if (!data) return null;
  const s = data.settings;

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const save = (patch: Partial<StatusData["settings"]>) => run("settings", () => api("/api/whatsapp/status-settings", { method: "PUT", json: patch }));
  const toggle = async (on: boolean) => {
    if (on && !(await confirmDialog({ title: "Ligar os posts automáticos?", body: `A cada ${s.everyDays} dia(s) sai um status público no WhatsApp do assistente para ${data.audience} pessoa(s).`, confirmLabel: "Ligar" }))) return;
    await save({ enabled: on });
  };
  const post = async (p: StatusPost) => {
    if (!(await confirmDialog({ title: "Postar no status agora?", body: `Vai aparecer para ${data.audience} pessoa(s) que conversam com o assistente e some em 24 horas.`, confirmLabel: "Postar" }))) return;
    await run(p.id, async () => {
      if (edits[p.id] !== undefined && edits[p.id] !== p.caption) await api(`/api/whatsapp/status-posts/${p.id}`, { method: "PATCH", json: { caption: edits[p.id] } });
      await api(`/api/whatsapp/status-posts/${p.id}/post`, { method: "POST" });
    });
  };

  return (
    <div className="card card-pad" style={{ marginTop: 16 }}>
      <h3>Status do WhatsApp</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        O Bolinho em cenas divertidas usando o Planejai e, de vez em quando, um post do blog com o link. Some em 24 horas, como qualquer status.
        Quem vê: as {data.audience} pessoas que conversam com o assistente e têm o número dele salvo.
      </p>
      <label className="set-switch">
        <input type="checkbox" checked={s.enabled} disabled={busy === "settings"} onChange={(e) => void toggle(e.target.checked)} />
        <span>
          <strong>Postar sozinho</strong>
          <small>Cada cena nova é uma imagem da rota Imagens (Agentes &gt; Modelos), uns US$ 0,04. O post do blog reaproveita a capa e não custa nada. Estimativa com o ritmo abaixo: {usd(data.monthlyUsd)} por mês.</small>
        </span>
      </label>
      <div className="wa-status-when">
        <span className="muted">A cada</span>
        <select className="select" value={s.everyDays} onChange={(e) => void save({ everyDays: Number(e.target.value) })} aria-label="De quantos em quantos dias">
          {[1, 2, 3, 4, 5, 7].map((d) => <option key={d} value={d}>{d === 1 ? "1 dia" : `${d} dias`}</option>)}
        </select>
        <span className="muted">a partir das</span>
        <select className="select" value={s.hour} onChange={(e) => void save({ hour: Number(e.target.value) })} aria-label="Hora">
          {Array.from({ length: 15 }, (_, i) => i + 7).map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}h</option>)}
        </select>
        <span className="muted">e</span>
        <select className="select" value={s.blogEvery} onChange={(e) => void save({ blogEvery: Number(e.target.value) })} aria-label="Posts do blog">
          <option value={0}>nunca o blog</option>
          {[2, 3, 4, 5].map((n) => <option key={n} value={n}>1 a cada {n} é do blog</option>)}
        </select>
      </div>
      <div className="row row-wrap" style={{ gap: 10 }}>
        <button className="btn btn-primary" disabled={!!busy} onClick={() => void run("new", () => api("/api/whatsapp/status-posts", { method: "POST", json: { kind: "imagem" } }))}>
          {busy === "new" ? "Gerando a imagem…" : "Gerar cena do Bolinho"}
        </button>
        <button className="btn" disabled={!!busy} onClick={() => void run("blog", () => api("/api/whatsapp/status-posts", { method: "POST", json: { kind: "blog" } }))}>
          {busy === "blog" ? "Montando…" : "Usar post do blog"}
        </button>
        {s.lastAt && <span className="muted">Último automático {ago(s.lastAt)}</span>}
      </div>
      <ErrorBox error={err} />
      {data.posts.length > 0 && (
        <div className="wa-status-grid">
          {data.posts.map((p) => (
            <div key={p.id} className={`wa-status-item${p.kind === "blog" ? " is-blog" : ""}`}>
              <img src={`/api/whatsapp/status-posts/${p.id}/img`} alt={p.kind === "blog" ? "Capa do post do blog" : "Cena do Bolinho"} loading="lazy" />
              <div className="wa-status-body">
                {p.status === "postado" ? (
                  <>
                    <span className="badge badge-ok">Postado {p.posted_at ? ago(p.posted_at) : ""} · {p.recipients ?? 0} pessoa(s)</span>
                    <p className="wa-status-caption">{p.caption}</p>
                  </>
                ) : (
                  <>
                    {p.status === "falhou" && <span className="badge badge-err" title={p.error ?? ""}>Não saiu: {p.error}</span>}
                    <textarea className="input" aria-label="Legenda" maxLength={700} value={edits[p.id] ?? p.caption} onChange={(e) => setEdits({ ...edits, [p.id]: e.target.value })} />
                    <div className="wa-status-actions">
                      <button className="btn btn-primary" disabled={!!busy} onClick={() => void post(p)}>{busy === p.id ? "Postando…" : "Postar agora"}</button>
                      <button className="btn" disabled={!!busy} onClick={() => void run(p.id, () => api(`/api/whatsapp/status-posts/${p.id}`, { method: "DELETE" }))}>Descartar</button>
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
