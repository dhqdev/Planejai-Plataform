import { useEffect, useRef, useState } from "react";
import { api, phoneFmt } from "./api";
import { useApi } from "./hooks";
import { Icon } from "./icons";

/** Canais onde a pessoa conversa com o assistente: WhatsApp (o número dela) e Telegram (liga com um toque). */
export function Connections({ owner }: { owner?: boolean }) {
  const { data, reload } = useApi<any>("/api/me/connections");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  // depois de abrir o bot, confere sozinho quando a conexão entra
  useEffect(() => {
    if (!waiting) return;
    let n = 0;
    timer.current = setInterval(() => {
      n++;
      void reload();
      if (n > 60) setWaiting(false);
    }, 3000);
    return () => clearInterval(timer.current);
  }, [waiting, reload]);
  useEffect(() => {
    if (data?.telegram?.connected) setWaiting(false);
  }, [data?.telegram?.connected]);

  if (!data) return null;
  const tg = data.telegram;
  if (!tg.available && !owner) return null;

  const connect = async () => {
    setBusy(true);
    setError(null);
    // abre a aba antes do await (o Safari bloqueia janela aberta depois)
    const win = window.open("", "_blank");
    try {
      const r = await api<{ url: string }>("/api/me/connections/telegram", { method: "POST" });
      if (win) win.location.href = r.url;
      else window.location.href = r.url;
      setWaiting(true);
    } catch (e) {
      win?.close();
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-pad conn-card">
      <h3>Conexões</h3>
      <p className="muted conn-sub">Onde você conversa com o assistente. É o mesmo assistente, com a mesma memória, em qualquer um.</p>
      <div className="conn-row">
        <span className="conn-ico wa"><Icon name="phone" size={18} /></span>
        <div className="conn-text">
          <strong>WhatsApp</strong>
          <small className="muted">{data.whatsapp ? phoneFmt(data.whatsapp.phone) : "Nenhum número ligado"}</small>
        </div>
        {data.whatsapp && <span className="badge badge-ok"><span className="dot dot-ok" />Ligado</span>}
      </div>
      <div className="conn-row">
        <span className="conn-ico tg"><Icon name="send" size={18} /></span>
        <div className="conn-text">
          <strong>Telegram</strong>
          <small className="muted">
            {!tg.available ? "Configure o bot em Integrações > Telegram" : tg.connected ? `Conectado${tg.connected.username ? ` como @${tg.connected.username}` : ""}` : waiting ? "Toque em Iniciar no Telegram e volte aqui" : `Converse pelo bot @${tg.bot}`}
          </small>
        </div>
        {tg.available &&
          (tg.connected ? (
            <button className="btn btn-sm" disabled={busy} onClick={async () => { await api("/api/me/connections/telegram", { method: "DELETE" }); void reload(); }}>Desconectar</button>
          ) : (
            <button className="btn btn-sm btn-brand" disabled={busy || !data.linked} onClick={connect}>{waiting ? "Abrir de novo" : "Conectar"}</button>
          ))}
      </div>
      {error && <div className="error-box" style={{ marginTop: 10 }}>{error}</div>}
    </div>
  );
}
