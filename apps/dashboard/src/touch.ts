/**
 * Toque com sensação de app nativo: vibração curtinha ao tocar em botões, abas e itens clicáveis.
 * Android usa navigator.vibrate. iPhone não tem essa API: lá o Safari (iOS 18+) dá o "tique" do sistema
 * quando um <input type="checkbox" switch> muda, então clicamos num switch escondido dentro do toque.
 * O visual de "afundar" fica no CSS (:active).
 */
const TAPPABLE = "button, a, .tab, .list-item, .line-item.clickable, .clickable, .connector, summary, [role='button'], label.btn, .sheet-item";

const canVibrate = () => typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
const coarse = () => matchMedia("(pointer: coarse)").matches;

let iosSwitch: HTMLLabelElement | null = null;
function iosTick() {
  if (!iosSwitch) {
    iosSwitch = document.createElement("label");
    iosSwitch.setAttribute("aria-hidden", "true");
    iosSwitch.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    input.tabIndex = -1;
    iosSwitch.appendChild(input);
    document.body.appendChild(iosSwitch);
  }
  iosSwitch.click();
}

let last = 0;
/** Vibração curta. No iPhone só funciona dentro de um toque (click/touchend), então chame no onClick. */
export function haptic(ms = 8) {
  const now = Date.now();
  if (now - last < 40) return; // evita dois tiques no mesmo toque
  last = now;
  try {
    if (!coarse()) return;
    if (canVibrate()) navigator.vibrate(ms);
    else iosTick();
  } catch {
    /* sem suporte */
  }
}

function tappable(target: EventTarget | null) {
  const el = (target as Element | null)?.closest?.(TAPPABLE) as HTMLElement | null;
  if (!el || (el as HTMLButtonElement).disabled || el === iosSwitch) return null;
  return el;
}
const strength = (el: HTMLElement) => (el.classList.contains("btn-primary") || el.classList.contains("btn-danger") ? 12 : 6);

export function installTouchFeedback() {
  if (canVibrate()) {
    // Android: vibra já ao encostar o dedo, sem esperar soltar
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (e.pointerType !== "touch") return;
        const el = tappable(e.target);
        if (el) haptic(strength(el));
      },
      { passive: true },
    );
  } else {
    // iPhone: o tique precisa acontecer dentro do gesto, que no toque só vale no click
    document.addEventListener(
      "click",
      (e) => {
        if (!e.isTrusted || e.target === iosSwitch || iosSwitch?.contains(e.target as Node)) return;
        const el = tappable(e.target);
        if (el) haptic(strength(el));
      },
      { capture: true },
    );
  }
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
