/* Service worker do Planejai: abre instantâneo e funciona com internet ruim.
   - arquivos do app (/assets, ícones): cache primeiro (têm hash no nome, nunca mudam)
   - páginas: rede primeiro, cai para o app em cache se estiver offline
   - /api, /webhooks e /version.json: nunca passam pelo cache (dados sempre frescos e privados)
   O VERSION abaixo é trocado a cada build (vite.config.ts), então cada deploy instala um SW novo. */
const VERSION = "planejai-v2";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("message", (e) => {
  if (e.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/webhooks/") || url.pathname === "/health" || url.pathname === "/version.json") return;

  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            // nunca guarda o index.html no lugar de um arquivo que sumiu no deploy
            const type = res.headers.get("content-type") || "";
            if (res.ok && !type.includes("text/html")) caches.open(VERSION).then((c) => c.put(req, res.clone()));
            return res;
          }),
      ),
    );
    return;
  }

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put("/", res.clone()));
          return res;
        })
        .catch(() => caches.match("/")),
    );
  }
});
