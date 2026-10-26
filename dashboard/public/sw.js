// The cockpit's service worker: the shell opens offline, and nothing behind the token is ever stored,
// so a lost phone's cache holds the page and no run data. A new SHELL list ships with a new CACHE name.
const CACHE = "factory-shell-v2";
const SHELL = [
  "/",
  "/tokens.css",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icon.svg",
  "/apple-touch-icon.png",
  "/fonts/geist.woff2",
  "/lib/analytics-state.js",
  "/lib/e2e.js",
  "/lib/exec-summary.js",
  "/lib/markdown.js",
  "/lib/relay-follow.js",
  "/lib/remote.js",
  "/lib/routes.js",
  "/lib/run-metrics.js",
  "/lib/run-page.js",
  "/lib/runs-board.js",
  "/lib/stations.js",
  "/lib/status-loader.js",
  "/lib/task-presentation.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  const path = url.pathname === "/index.html" ? "/" : url.pathname;
  if (!SHELL.includes(path)) return;
  // Network first, so a deploy shows at once; the cached copy only answers when the network cannot.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((c) => c.put(path, copy)));
        }
        return res;
      })
      .catch(() => caches.match(path).then((hit) => hit ?? Response.error())),
  );
});

// A push carries only the two notice kinds (src/ports/notifier.ts); tapping one opens its issue.
self.addEventListener("push", (event) => {
  let n = {};
  try {
    n = event.data ? event.data.json() : {};
  } catch {}
  if (n.kind !== "needs-you" && n.kind !== "done") return;
  const url = typeof n.url === "string" && n.url.startsWith("/") ? n.url : "/";
  event.waitUntil(
    self.registration.showNotification(String(n.title ?? "Factory"), {
      body: String(n.body ?? ""),
      icon: "/apple-touch-icon.png",
      tag: url,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data?.url ?? "/"));
});
