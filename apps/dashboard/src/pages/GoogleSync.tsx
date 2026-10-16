import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../hooks";
import { Icon } from "../icons";

type Mine = { owner: boolean; integrations: { id: string; connected: boolean; available: boolean; label: string | null }[] };
type Platform = { integrations: { id: string; connected: boolean }[] };

/**
 * Sincronizar com o Google Agenda direto da Agenda, sem passar por Minha conta: o cliente conecta a conta
 * dele (OAuth pessoal, volta para /agenda); o dono usa a conexão da plataforma em Integrações.
 */
export function GoogleSync({ isSuper, variant }: { isSuper: boolean; variant: "side" | "phone" }) {
  const nav = useNavigate();
  const mine = useApi<Mine>("/api/me/integrations");
  const platform = useApi<Platform>(isSuper ? "/api/integrations" : null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  // volta do Google: ?connected=google ou ?error=...
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("connected") === "google") setNote({ ok: true, text: "Pronto, sua agenda do Google está sincronizada." });
    else if (q.get("error")) setNote({ ok: false, text: `Não deu para conectar: ${q.get("error")}` });
    if (q.has("connected") || q.has("error")) history.replaceState(history.state, "", location.pathname);
  }, []);

  if (!mine.data) return null;
  const personal = mine.data.integrations.find((i) => i.id === "google");
  const owner = mine.data.owner || !personal;
  const connected = owner ? Boolean(platform.data?.integrations.find((i) => i.id === "google")?.connected) : Boolean(personal?.connected);
  // cliente sem o app do Google configurado pelo dono: não há o que oferecer
  if (!owner && !personal?.available) return null;
  if (owner && !isSuper) return null;
  const label = owner ? null : personal?.label;
  // no celular, já sincronizada não ocupa espaço (só o aviso logo depois de conectar)
  if (variant === "phone" && connected && !note) return null;

  const connect = async () => {
    if (owner) return nav("/integrations");
    setBusy(true);
    setNote(null);
    try {
      const r = await api<{ url: string }>("/api/me/integrations/google/oauth?volta=agenda", { method: "POST" });
      location.href = r.url;
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
      setBusy(false);
    }
  };

  return (
    <div className={`gsync gsync-${variant} ${connected ? "on" : ""}`}>
      <span className="gsync-ico" aria-hidden="true"><Icon name={connected ? "check" : "calendar"} size={variant === "phone" ? 18 : 20} /></span>
      <div className="gsync-text">
        <strong>{connected ? "Sincronizada com o Google" : "Google Agenda"}</strong>
        <small className={note && !note.ok ? "err" : undefined}>{note?.text ?? (connected ? (label ?? "Seus compromissos aparecem nos dois lugares") : "Veja tudo junto e mande seus lembretes para lá")}</small>
      </div>
      {connected ? (
        <button className="gsync-link" onClick={() => nav(owner ? "/integrations" : "/profile")}>Gerenciar</button>
      ) : (
        <button className="btn btn-brand btn-sm gsync-btn" disabled={busy} onClick={connect}>{busy ? "Abrindo..." : "Sincronizar"}</button>
      )}
    </div>
  );
}
