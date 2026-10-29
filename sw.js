// Service Worker: App läuft auch ohne Internet (Ansicht des letzten Stands).
const CACHE = "rechnungen-v7";
const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js";
const SHELL = ["./", "./index.html", "./config.js", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png",
  "./brand/mono.svg", "./brand/wordmark.svg", "./brand/logo-rechnung.png", "./fonts/outfit-latin-wght-normal.woff2", "./fonts/outfit-latin-ext-wght-normal.woff2", SUPABASE_JS];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith(".supabase.co")) return; // Daten immer live

  if (req.url === SUPABASE_JS) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req)));
    return;
  }
  if (url.origin !== location.origin) return;

  // Eigene Dateien: erst Netz (für Updates), sonst Cache
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match("./index.html"))),
  );
});
