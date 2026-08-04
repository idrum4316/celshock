/**
 * register.ts — the two things that turn the page into an installable app:
 * the service worker registration, and the fullscreen gesture a phone needs
 * when the game is opened in a browser tab rather than from the home screen.
 *
 * Nothing here touches the game. `Game` owns the round; this owns the window
 * the round is drawn in, which is why it is a module of its own rather than
 * more wiring in `Game`.
 */

/**
 * Installs `sw.js` (see `src/pwa/sw.js`), which is what makes the game
 * launchable offline and is half of what makes it installable at all.
 *
 * Production only: in dev there is no worker to register — the plugin that
 * emits it is `apply: "build"` — and a worker caching a Vite dev server's
 * module graph would be actively harmful.
 *
 * Registration is deferred to `load` so it never competes with the bundle it
 * exists to cache: a service worker that installs during startup pulls a few
 * megabytes down a second time while the first copy is still arriving.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    // A failure here is not worth surfacing: an unregistered worker costs
    // offline launch and nothing else, and the commonest cause is the page
    // being served over plain HTTP from something other than localhost.
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

/**
 * Takes the screen on a touch device, if it is not already taken.
 *
 * This is for the browser-tab case only. An installed app declares
 * `"display": "fullscreen"` in the manifest and comes up without any chrome to
 * escape from, and on the desktop the pointer lock already does the immersing
 * — a page that went fullscreen under a mouse click nobody asked it to would
 * be a nuisance, so the coarse-pointer test is the gate, not an optimisation.
 *
 * **It is the document that goes fullscreen, never the canvas.** A fullscreen
 * element is the only thing drawn, and the HUD is a `<div>` SIBLING of the
 * canvas — so fullscreening the canvas plays the game with the scene at full
 * size and no tickets, no flags, no crosshair and no deploy map. It looks like
 * the HUD failed to build.
 *
 * Everything here is best-effort by design. iPhone Safari has no element
 * fullscreen at all (`requestFullscreen` is simply absent, hence the typeof
 * test rather than a promise that rejects on every tap), and the orientation
 * lock is Android-only and refuses outside fullscreen — so both failures are
 * swallowed. The game plays either way; this only removes the URL bar.
 */
export function enterFullscreenOnTouch(): void {
  if (!window.matchMedia("(pointer: coarse)").matches) return;
  if (document.fullscreenElement) return;
  const el = document.documentElement;
  if (typeof el.requestFullscreen !== "function") return;

  void el
    .requestFullscreen({ navigationUI: "hide" })
    .then(() => {
      // A first-person shooter has one orientation. The manifest says so for
      // the installed app; this says it for the tab.
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (o: string) => Promise<void>;
      };
      if (typeof orientation?.lock === "function") {
        void orientation.lock("landscape").catch(() => {});
      }
    })
    .catch(() => {});
}
