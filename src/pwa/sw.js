/**
 * sw.js — the service worker, and the reason the game runs with the phone in
 * flight mode. This file is a TEMPLATE: it is never served as it stands.
 * `vite.config.ts`'s `serviceWorker()` plugin reads it after a build, replaces
 * `__PRECACHE__` with the manifest of what that build actually emitted, and
 * writes the result to `dist/sw.js`.
 *
 * It is plain JavaScript, not TypeScript, because nothing imports it — it is
 * copied as text — and a `.js` file under `src/` is invisible to `tsc`. Keep
 * it small enough to read in one sitting; there is no typecheck behind it.
 *
 * The strategy is cache-first over a precache, which is the right one here for
 * a reason particular to this game: the bundle is a few megabytes of
 * Babylon.js and every byte of it is needed before the first frame, so a
 * network-first worker would spend a round trip per launch to re-fetch files
 * whose names already encode their contents.
 *
 *   install   fetch the whole build into a cache named after that build.
 *   activate  drop every other cache — a version that is no longer current is
 *             a few megabytes of a build nobody will load again.
 *   fetch     same-origin GETs come from the cache when they are there, and
 *             fill it when they are not. Everything else is passed through.
 *
 * Freshness comes from the worker's own update check rather than from the
 * fetch handler: the precache manifest is part of this file, so any change to
 * any emitted file changes these bytes, the browser sees a byte-different
 * worker on its next update check, and the new build installs alongside the
 * old one. `skipWaiting`/`clients.claim` then make the launch after that one
 * the current build. That is one launch behind, which is the price of not
 * waiting on the network to start, and it is why `sw.js` itself MUST be served
 * no-cache (see docker/nginx.conf) — a cached worker can never notice it is
 * out of date.
 */

/** Replaced at build time with `{ version, urls }`. */
const PRECACHE = __PRECACHE__;

const CACHE = `hollowmere-${PRECACHE.version}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // `reload` so the install populates from the network rather than from
      // the HTTP cache, which may still be holding the previous deploy's
      // index.html — the one unhashed file, and the one that would silently
      // pin the whole app to the wrong asset URLs.
      await cache.addAll(
        PRECACHE.urls.map((url) => new Request(url, { cache: "reload" })),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.map((name) => (name === CACHE ? null : caches.delete(name))),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // A navigation is always the app shell. Answering it from the precache by
  // path (rather than by the request, which carries the query string and any
  // deep link) is what lets `/?anything` launch offline.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const shell = await cache.match("/");
        return shell || fetch(req);
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      // Only a clean same-origin response is worth keeping. An opaque or
      // errored one cached here would be served for the life of the build.
      if (res.ok && res.type === "basic") {
        void cache.put(req, res.clone());
      }
      return res;
    })(),
  );
});
