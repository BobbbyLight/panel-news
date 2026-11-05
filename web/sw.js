/**
 * sw.js: app shell is cache-first (precached); data JSON is network-first
 * with the last good copy as the offline fallback. Cross-origin requests
 * (the read-mode Worker, the GitHub API) pass straight through.
 */
const VERSION = "v1";
const SHELL = `shell-${VERSION}`;
const DATA = "data";

const PRECACHE = [
  "./", "index.html", "manifest.json",
  "css/fonts.css", "css/tokens.css", "css/base.css", "css/app.css",
  "js/boot.js", "js/app.js", "js/db.js", "js/theming.js", "js/data.js", "js/loaded.js",
  "fonts/atkinson-hyperlegible/atkinson-hyperlegible-latin-400-normal.woff2",
  "fonts/atkinson-hyperlegible/atkinson-hyperlegible-latin-700-normal.woff2",
  "fonts/atkinson-hyperlegible/atkinson-hyperlegible-latin-400-italic.woff2",
  "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith(".json") && !url.pathname.endsWith("manifest.json")) {
    // Network first; store under the bare path so cache-busted URLs share one entry.
    const key = url.origin + url.pathname;
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(DATA).then((c) => c.put(key, copy));
          }
          return res;
        })
        .catch(() => caches.open(DATA).then((c) => c.match(key)).then((r) => r || Response.error()))
    );
    return;
  }

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(req, copy));
          }
          return res;
        })
    )
  );
});
