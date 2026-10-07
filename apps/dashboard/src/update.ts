/**
 * Versão nova do app: cada build tem um id (__BUILD__) e publica /version.json. Ao abrir, ao voltar
 * para o app e a cada 5 min o app compara os dois; se mudou, aparece o botão "Atualizar" (celular e
 * notebook). Tocar nele instala o service worker novo e recarrega.
 */
declare const __BUILD__: string;

let available = false;
const listeners = new Set<(v: boolean) => void>();

function set(v: boolean) {
  if (available === v) return;
  available = v;
  listeners.forEach((l) => l(v));
}

export function onUpdateAvailable(fn: (v: boolean) => void) {
  listeners.add(fn);
  fn(available);
  return () => {
    listeners.delete(fn);
  };
}

export async function checkForUpdate() {
  if (import.meta.env.DEV) return false;
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return false;
    const { build } = (await res.json()) as { build?: string };
    if (build && build !== __BUILD__) set(true);
  } catch {
    /* offline: tenta de novo depois */
  }
  return available;
}

export async function applyUpdate() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
    reg?.waiting?.postMessage("skip-waiting");
  } catch {
    /* sem service worker */
  }
  location.reload();
}

export function watchForUpdates() {
  if (import.meta.env.DEV) return;
  setTimeout(checkForUpdate, 2500);
  setInterval(() => !document.hidden && checkForUpdate(), 5 * 60_000);
  document.addEventListener("visibilitychange", () => !document.hidden && checkForUpdate());
  window.addEventListener("focus", () => checkForUpdate());
  // aba antiga aberta depois de um deploy: o pedaço da tela que ela pede não existe mais
  window.addEventListener("vite:preloadError", (e) => {
    e.preventDefault();
    set(true);
    try {
      const last = Number(sessionStorage.getItem("pj-reloaded") ?? 0);
      if (Date.now() - last > 15_000) {
        sessionStorage.setItem("pj-reloaded", String(Date.now()));
        location.reload();
      }
    } catch {
      /* sem storage: fica o botão */
    }
  });
}
