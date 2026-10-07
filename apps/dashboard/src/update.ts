/**
 * Versão nova do app: cada build tem um id (__BUILD__) e publica /version.json. Ao abrir, ao voltar
 * para o app e a cada 5 min o app compara os dois; se mudou, aparece o botão "Atualizar" (celular e
 * notebook). Tocar nele limpa o cache e abre a versão nova.
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

/** Apaga tudo o que o navegador guardou do app: service workers e caches. */
export async function clearAppCache() {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
  } catch {
    /* sem service worker */
  }
  try {
    const keys = (await caches?.keys()) ?? [];
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    /* sem Cache Storage */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** O deploy terminou de verdade? A página nova e o JS dela precisam responder (não o index no lugar do JS). */
async function serverReady(): Promise<string | null> {
  try {
    const v = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!v.ok) return null;
    const { build } = (await v.json()) as { build?: string };
    if (!build || build === __BUILD__) return null;
    const html = await (await fetch(`/?t=${Date.now()}`, { cache: "no-store" })).text();
    const src = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    if (!src) return null;
    const js = await fetch(src, { cache: "no-store" });
    if (!js.ok || !(js.headers.get("content-type") ?? "").includes("javascript")) return null;
    return build;
  } catch {
    return null;
  }
}

function overlay() {
  const el = document.createElement("div");
  el.className = "pj-updating";
  el.innerHTML = '<div class="pj-updating-dot"></div><div>Atualizando</div>';
  document.body.appendChild(el);
}

/**
 * "Atualizar": espera o servidor terminar de subir a versão nova, limpa service worker e cache e
 * abre a página do zero. Antes recarregava no meio do deploy e ficava em branco.
 */
export async function applyUpdate() {
  overlay();
  let build: string | null = null;
  for (let i = 0; i < 30 && !build; i++) {
    build = await serverReady();
    if (!build) await sleep(2000);
  }
  await clearAppCache();
  const url = new URL(location.href);
  url.searchParams.set("v", build ?? String(Date.now()));
  location.replace(url.toString());
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
        void applyUpdate();
      }
    } catch {
      /* sem storage: fica o botão */
    }
  });
}
