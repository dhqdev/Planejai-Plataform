/* Service worker do Planejai: abre instantâneo e funciona com internet ruim.
   - arquivos do app (/assets, ícones): cache primeiro (têm hash no nome, nunca mudam)
   - páginas: rede primeiro, cai para o app em cache se estiver offline
   - /api, /webhooks e /version.json: nunca passam pelo cache (dados sempre frescos e privados)
   - push: alarme toca como ligação (fica na tela até a pessoa agir, vibra longo, Parar / Soneca 5 min)
   O VERSION abaixo é trocado a cada build (vite.config.ts), então cada deploy instala um SW novo. */
const VERSION = "planejai-v3";
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

/* Alarme: chega por Web Push. Parar e Soneca funcionam direto da notificação (token assinado no push, sem login). */
const RING = [900, 400, 900, 400, 900, 400, 900, 400, 900, 400, 900];

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : "" };
  }
  if (d.type !== "alarm") {
    // todo push precisa mostrar algo (o iPhone corta a inscrição de quem não mostra)
    e.waitUntil(self.registration.showNotification("Planejai", { body: d.body || "Você tem uma novidade.", icon: "/icons/icon-192.png" }));
    return;
  }
  const url = d.id ? `/alarme?id=${d.id}` : "/alarme?teste=1";
  e.waitUntil(
    Promise.all([
      self.registration.showNotification("Planejai está te ligando", {
        body: d.label ? `Alarme: ${d.label}` : "Alarme",
        tag: `alarm-${d.id || "teste"}`,
        renotify: true,
        requireInteraction: true,
        vibrate: RING,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        timestamp: d.at ? Date.parse(d.at) : Date.now(),
        data: { url, id: d.id || null, token: d.token || null },
        actions: d.token
          ? [
              { action: "stop", title: "Parar" },
              { action: "snooze", title: "Soneca 5 min" },
            ]
          : [{ action: "stop", title: "Parar" }],
      }),
      // app aberto na frente: abre a tela do alarme
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => list.forEach((c) => c.postMessage({ type: "pj-alarm", url }))),
    ]),
  );
});

self.addEventListener("notificationclick", (e) => {
  const n = e.notification;
  const data = n.data || {};
  n.close();
  if ((e.action === "stop" || e.action === "snooze") && data.token) {
    e.waitUntil(
      fetch("/api/alarm-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: data.token, action: e.action }) }).catch(() => {}),
    );
    return;
  }
  if (e.action === "stop") return;
  const url = data.url || "/alarme";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => new URL(c.url).origin === location.origin);
      if (open) return open.focus().then((c) => (c || open).postMessage({ type: "pj-alarm", url }));
      return self.clients.openWindow(url);
    }),
  );
});
