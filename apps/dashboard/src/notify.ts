import { useEffect, useState } from "react";
import { api } from "./api";
import { liveOn, onLive } from "./live";

/**
 * Contador de não lidas (bolinha no menu). Um único poll para o app inteiro; avisa o navegador
 * (Notification) quando chega algo novo com o app aberto e a pessoa deixou.
 */
type State = { unread: number; last: string | null };
let state: State = { unread: 0, last: null };
const subs = new Set<(s: State) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let offLive: (() => void) | null = null;
let lastPoll = 0;

async function poll() {
  lastPoll = Date.now();
  try {
    const next = await api<State>("/api/notifications/unread");
    const fresh = next.unread > state.unread && next.last && next.last !== state.last;
    if (fresh && state.last !== null) browserNotify(next.unread);
    state = { unread: next.unread, last: next.last ?? state.last ?? "" };
    subs.forEach((f) => f(state));
  } catch {
    /* offline ou deslogado: tenta no próximo */
  }
}

function browserNotify(n: number) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted" || document.visibilityState === "visible") return;
    new Notification("Planejai", { body: n === 1 ? "Você tem 1 notificação nova." : `Você tem ${n} notificações novas.`, icon: "/icons/icon-192.png", tag: "pj-notif" });
  } catch {
    /* navegador sem suporte */
  }
}

export function refreshUnread() {
  void poll();
}

export function useUnread(enabled: boolean) {
  const [s, setS] = useState(state);
  useEffect(() => {
    if (!enabled) return;
    subs.add(setS);
    if (!timer) {
      void poll();
      // com o tempo real ligado, a bolinha acende na hora (aviso da tabela notifications); o poll é só segurança
      timer = setInterval(() => (!liveOn() || Date.now() - lastPoll > 120_000) && void poll(), 30_000);
      offLive = onLive(["notifications"], () => void poll());
    }
    const onVis = () => document.visibilityState === "visible" && void poll();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      subs.delete(setS);
      document.removeEventListener("visibilitychange", onVis);
      if (!subs.size && timer) {
        clearInterval(timer);
        timer = null;
        offLive?.();
        offLive = null;
        state = { unread: 0, last: null };
      }
    };
  }, [enabled]);
  return s.unread;
}
