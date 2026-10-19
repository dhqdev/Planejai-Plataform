import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { ErrorBox } from "./components";
import { useApi } from "./hooks";
import { haptic } from "./touch";

export type Alarm = { id: string; label: string; ring_at: string; status: string; snoozes: number; fired_at: string | null };
type AlarmsData = {
  alarms: Alarm[];
  devices: { endpoint: string }[];
  vapidPublicKey: string;
};

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

/** Dá para tocar alarme neste aparelho (no iPhone, só com o app na tela de início). */
export const alarmsPossible = () => pushSupported() && !(isIos() && !isStandalone());

/**
 * Liga o alarme neste aparelho: pede a permissão de notificação e inscreve no push. Chamado direto no toque
 * (o navegador só pede a permissão dentro de um gesto), pela pergunta no fim da primeira conversa.
 * Devolve false quando a pessoa negou ou não há WhatsApp ligado (sem alarme para tocar).
 */
export async function enableAlarmsHere() {
  if (!alarmsPossible()) return false;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return false;
  const data = await api<AlarmsData>("/api/alarms").catch(() => null);
  if (!data?.vapidPublicKey) return false;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(data.vapidPublicKey) });
  await api("/api/push/subscribe", { method: "POST", json: { subscription: sub.toJSON() } });
  return true;
}

export const alarmTime = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return today ? `hoje, ${hm}` : `${d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" })}, ${hm}`;
};

/**
 * Alarmes (Minha conta e tela /alarme): ligar o alarme neste aparelho, testar e ver/cancelar os próximos. O agente não cria alarme novo (só lembretes); aqui ficam os que já existiam.
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
      return "Pronto: as notificações chegam neste aparelho.";
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

  const test = () =>
    run(async () => {
      const r = await api<{ push: { sent: number } }>("/api/alarms/test", { method: "POST", json: {} });
      return r.push.sent ? "Teste enviado. Deve chegar em alguns segundos." : "Nenhum aparelho com notificação ligada.";
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
        Os alarmes que já estavam marcados chegam no WhatsApp e como notificação neste aparelho. Para coisas novas, peça um lembrete no WhatsApp.
      </p>
      {iosHint ? (
        <p className="muted" style={{ fontSize: 13 }}>
          No iPhone a notificação só chega com o Planejai na tela de início: toque em Compartilhar, depois em Adicionar à Tela de Início, e abra por lá (iOS 16.4 ou mais novo).
        </p>
      ) : !pushSupported() ? (
        <p className="muted" style={{ fontSize: 13 }}>Este navegador não recebe notificações. Os alarmes chegam só no WhatsApp.</p>
      ) : (
        <div className="row row-wrap" style={{ gap: 8, marginBottom: 12 }}>
          {here ? (
            <>
              <span className="muted" style={{ fontSize: 13, alignSelf: "center" }}>Ligado neste aparelho.</span>
              <button className="btn btn-sm" disabled={busy} onClick={test}>Testar</button>
              <button className="btn btn-sm btn-ghost" disabled={busy} onClick={disable}>Desligar aqui</button>
            </>
          ) : (
            <button className="btn btn-primary" disabled={busy || !data} onClick={enable}>Receber notificação neste aparelho</button>
          )}
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
