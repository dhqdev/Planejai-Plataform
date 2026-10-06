/**
 * Toque com sensação de app nativo: vibração curtinha (onde o aparelho suporta, ex. Android)
 * ao tocar em botões, abas e itens clicáveis. O visual de "afundar" fica no CSS (:active).
 */
const TAPPABLE = "button, a, .tab, .list-item, .clickable, .connector, summary, [role='button'], label.btn";

export function haptic(ms = 8) {
  try {
    if (navigator.vibrate && matchMedia("(pointer: coarse)").matches) navigator.vibrate(ms);
  } catch {
    /* sem suporte */
  }
}

export function installTouchFeedback() {
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType !== "touch") return;
      const el = (e.target as Element | null)?.closest?.(TAPPABLE) as HTMLElement | null;
      if (!el || (el as HTMLButtonElement).disabled) return;
      haptic(el.classList.contains("btn-primary") || el.classList.contains("btn-danger") ? 12 : 6);
    },
    { passive: true },
  );
}

/** Registra o service worker (só no build de produção): app instalável e abertura instantânea. */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

let deferredPrompt: any = null;
const listeners = new Set<() => void>();
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  listeners.forEach((l) => l());
});

export const canInstall = () => Boolean(deferredPrompt);
export function onInstallAvailable(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export async function promptInstall() {
  if (!deferredPrompt) return false;
  deferredPrompt.prompt();
  const r = await deferredPrompt.userChoice.catch(() => null);
  deferredPrompt = null;
  return r?.outcome === "accepted";
}
export const isStandalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true;
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
