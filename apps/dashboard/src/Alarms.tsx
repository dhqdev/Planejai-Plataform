import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { ErrorBox } from "./components";
import { useApi } from "./hooks";
import { haptic } from "./touch";

export type Alarm = { id: string; label: string; ring_at: string; status: string; snoozes: number; fired_at: string | null };
type Mode = "push" | "call" | "both";
type AlarmsData = {
  alarms: Alarm[];
  devices: { endpoint: string }[];
  mode: Mode;
  callAvailable: boolean;
  vapidPublicKey: string;
};

const MODES: { id: Mode; label: string }[] = [
  { id: "push", label: "Notificação" },
  { id: "call", label: "Ligação" },
  { id: "both", label: "Os dois" },
];

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as any).standalone === true;
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";

function keyBytes(base64: string) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export const alarmTime = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return today ? `hoje, ${hm}` : `${d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" })}, ${hm}`;
};

/**
 * Alarmes (Minha conta e tela /alarme): ligar o alarme neste aparelho, escolher como ele avisa,
 * testar e ver/cancelar os próximos. Os alarmes são criados pelo WhatsApp ("cria um alarme daqui a 15 minutos").
 */
export function AlarmSettings() {
  const { data, reload, error: loadError } = useApi<AlarmsData>("/api/alarms");
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshSub = useCallback(async () => setEndpoint((await currentSubscription().catch(() => null))?.endpoint ?? null), []);
  useEffect(() => {
    void refreshSub();
  }, [refreshSub]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setMsg(null);
    haptic(8);
    try {
      const m = await fn();
      if (typeof m === "string") setMsg(m);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const enable = () =>
    run(async () => {
      if (!data) return;
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("O navegador não deixou mandar notificação. Libere nas configurações do site e tente de novo.");
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(data.vapidPublicKey) });
      await api("/api/push/subscribe", { method: "POST", json: { subscription: sub.toJSON() } });
      await refreshSub();
      await reload();
      return "Pronto: os alarmes tocam neste aparelho.";
    });

  const disable = () =>
    run(async () => {
      const sub = await currentSubscription();
      if (sub) {
        await api("/api/push/unsubscribe", { method: "POST", json: { endpoint: sub.endpoint } });
        await sub.unsubscribe().catch(() => {});
      }
      await refreshSub();
      await reload();
    });

  const test = (call: boolean) =>
    run(async () => {
      const r = await api<{ push: { sent: number }; call: { ok: boolean; skipped?: string; error?: string } | null }>("/api/alarms/test", { method: "POST", json: { call } });
      if (call) return r.call?.ok ? "Ligando para o seu número." : `A ligação não saiu: ${r.call?.skipped ?? r.call?.error ?? "erro"}`;
      return r.push.sent ? "Teste enviado. Deve tocar em alguns segundos." : "Nenhum aparelho com o alarme ligado.";
    });

  const setMode = (mode: Mode) =>
    run(async () => {
      await api("/api/alarms/settings", { method: "PUT", json: { mode } });
      await reload();
    });

  const cancel = (id: string) =>
    run(async () => {
      await api(`/api/alarms/${id}`, { method: "DELETE" });
      await reload();
    });

  if (loadError) return null; // sem WhatsApp ligado ao login: não há alarme para mostrar
  const here = Boolean(endpoint && data?.devices.some((d) => d.endpoint === endpoint));
  const upcoming = data?.alarms.filter((a) => a.status === "scheduled") ?? [];
  const iosHint = isIos() && !isStandalone();

  return (
    <div className="card card-pad">
      <h3>Alarmes</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Peça no WhatsApp, como "cria um alarme daqui a 15 minutos". Na hora ele toca neste aparelho como uma ligação, com o alarme na tela.
      </p>
      {iosHint ? (
        <p className="muted" style={{ fontSize: 13 }}>
          No iPhone o alarme só toca com o Planejai na tela de início: toque em Compartilhar, depois em Adicionar à Tela de Início, e abra por lá (iOS 16.4 ou mais novo).
        </p>
      ) : !pushSupported() ? (
        <p className="muted" style={{ fontSize: 13 }}>Este navegador não recebe notificações. Os alarmes chegam só no WhatsApp.</p>
      ) : (
        <div className="row row-wrap" style={{ gap: 8, marginBottom: 12 }}>
          {here ? (
            <>
              <span className="muted" style={{ fontSize: 13, alignSelf: "center" }}>Ligado neste aparelho.</span>
              <button className="btn btn-sm" disabled={busy} onClick={() => test(false)}>Testar</button>
              <button className="btn btn-sm btn-ghost" disabled={busy} onClick={disable}>Desligar aqui</button>
            </>
          ) : (
            <button className="btn btn-primary" disabled={busy || !data} onClick={enable}>Ligar alarme neste aparelho</button>
          )}
        </div>
      )}

      {data?.callAvailable && (
        <div className="field">
          <label id="alarm-mode">Como avisar</label>
          <div className="row row-wrap" role="group" aria-labelledby="alarm-mode" style={{ gap: 6 }}>
            {MODES.map((m) => (
              <button key={m.id} className={`chip ${data.mode === m.id ? "active" : ""}`} aria-pressed={data.mode === m.id} disabled={busy} onClick={() => setMode(m.id)}>
                {m.label}
              </button>
            ))}
            {data.mode !== "push" && (
              <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => test(true)}>Testar ligação</button>
            )}
          </div>
          <span className="help">Ligação é para o seu número do WhatsApp, no máximo 10 por dia.</span>
        </div>
      )}

      {msg && <div className="ok-box" role="status" style={{ margin: "8px 0" }}>{msg}</div>}
      <ErrorBox error={error} />

      {upcoming.length > 0 && (
        <div className="share-list">
          {upcoming.map((a) => (
            <div key={a.id} className="share-row">
              <span className="ellipsis">
                {a.label}
                <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}> · {alarmTime(a.ring_at)}</span>
              </span>
              <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => cancel(a.id)}>Cancelar</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
