# The installable app

The four files that make the build install to a home screen and launch offline,
and the phone-shaped details behind each. Split out of
[`CLAUDE.md`](../CLAUDE.md), which keeps the summary; this file is the contract
for `public/`, `src/pwa/` and the service-worker plugin.

The build installs to a home screen and launches fullscreen, landscape and offline.
Four files carry it: `public/manifest.webmanifest`, `public/icons/`,
`src/pwa/register.ts` and `src/pwa/sw.js`. Nothing in the game knows any of this
exists — `Game`'s one line is the fullscreen gesture.

**`public/` is the one place a URL is written by hand.** Vite copies it to `dist/`
unhashed, which is the point: a manifest names its icons, `index.html` names the
manifest, and a home screen keeps the `start_url` it installed with, so those paths
are a contract with something outside the build. The icons are generated and
*committed* (`npm run icons` → `scripts/generate-icons.mjs`, a zero-dependency PNG
encoder), so nothing at build time depends on a script having been run.

**The service worker is a template, not a module.** `src/pwa/sw.js` is never
imported and never typechecked; `vite.config.ts`'s `serviceWorker()` plugin reads it
in `writeBundle`, substitutes the whole `const PRECACHE = __PRECACHE__;` line for the
manifest of what was actually written to `dist/`, and emits `dist/sw.js`.

- **The version hashes every file's NAME AND CONTENTS.** Hashing names alone looks
  sufficient because Vite content-hashes asset filenames — but `index.html` is unhashed,
  and a byte-identical worker is one the browser never updates, so anything that
  changes only unhashed output would be served from cache forever. `index.html` still
  carries the head, the manifest link and the meta tags, and the next thing to live only
  there will not announce itself.
- **The substitution anchors on the declaration, not on the placeholder.** The file's
  header comment names `__PRECACHE__` twice; a plain string replace puts the manifest in
  the prose and leaves the code undefined.
- **`sw.js` must be served `no-cache`** (`docker/default.conf.template`). It is the
  update mechanism: a cached copy is a client that can never learn a new build exists.
- **Caching is cache-first over that precache**, because the bundle is a few
  megabytes of Babylon and every byte is needed before the first frame. The cost is that
  a returning player gets the previous build and the new one installs behind them, so a
  deploy takes effect on the launch *after* next.
- **The match server's endpoints are exempt from all of it, by path.** The fetch
  handler is cache-first over *everything* same-origin and fills the cache with what
  comes back, and in a deployed build `/matches` is same-origin — nginx proxies it onto
  the game's own domain. So without the exemption the lobby is answered from the cache
  after its first ever fetch and shows one frozen list of matches for the life of the
  build. `cache: "no-store"` on the request and `no-store` on the response do not save
  it: the Cache API implements none of HTTP's caching semantics, and a `cache.put` is
  a `cache.match` hit by URL forever. **This can only be seen on the deployed site** —
  there is no worker in dev and none on a first load — which is what makes it worth
  stating here rather than leaving to whoever reads `sw.js`.

Registration happens in `main.ts` **before** the `Game` is constructed and is
`import.meta.env.PROD`-gated: it must survive a Game that throws on a machine
without WebGL2, and a worker caching a dev server's module graph would be actively
harmful.

Details about the phone, each of which was a visible bug first:

- **Fullscreen is taken on `document.documentElement`, never on the canvas.** A
  fullscreen element is the only thing drawn and the HUD is a `<div>` *sibling* of the
  canvas, so fullscreening the canvas plays the game with no tickets, no flags, no
  crosshair and no deploy map. It is gated on a coarse pointer: an installed app is
  already fullscreen from the manifest, and on the desktop the pointer lock does the
  immersing.
- **A touch is felt nowhere in `InputManager`, and every screen a phone meets
  carries its own button** — the menu's and the round-over card's Deploy, the deploy
  screen's map and `#deploy-go`, the kit screen's — each listening for its own
  `pointerdown`, which a finger raises like any other pointer. A tap used to be
  latched into `confirmPressed` (the masks are held state and a tap has no hold) so
  that the title screen could be got past at all; that latch deployed the player off
  the menu's map and difficulty rows on the way, and went with the mouse.
- **`--ov-scale` scales `#overlay` and `#deploy` on short viewports** by growing the
  box to `100%/s` and scaling by `s` about the top-left, so the backdrop stays
  full-bleed and the desktop (s = 1) is untouched. Nothing in this HUD scrolls, and a
  landscape phone is ~350px tall against screens authored for 720p. **`#loadout` is
  deliberately excluded**: its stage is a hole the 3D turntable is placed through,
  back-projected from the same viewport fractions the CSS uses, so a transform would
  move the hole and leave the weapon behind it — which is also why it is the one screen
  carrying a short-viewport media query of its own.
- **Inside a scaled box, `vh` and `vw` are still the VIEWPORT's**, so a length written
  in them is scaled a second time on the way out. `#deploy`'s map is `calc(min(56vh,
  60vw) / var(--ov-scale))` for exactly that reason: at s = 0.45 the raw form rendered
  the map at a quarter of the height it asked for, and the divide is the identity on
  every desktop.

There are **no touch controls** — every input is keyboard, mouse or gamepad, so a
phone plays this with a pad paired to it. Menus and the deploy map take a tap;
nothing in a round does.
