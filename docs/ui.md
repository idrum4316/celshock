# The interface: five screens and the chrome

What each UI class owns, where a stylesheet lives, and how the screens between
the title and the world are driven by a pointer and a pad alike. Split out
of [`CLAUDE.md`](../CLAUDE.md), which keeps the summary; this file is the
contract for everything under `src/ui/`.

## The interface is five screens and the chrome

`src/ui/` holds one class per thing on screen, and `HUD` is not where a new one
goes: `OverlayScreen` owns the four full-screen cards, `DeployScreen` the deploy
map, `LoadoutScreen` the kit, `SettingsScreen` the settings list, `LobbyScreen`
the match browser, `Minimap` the corner map, and `HUD` **only** the gameplay
chrome.

**The boot screen is the one piece of interface that is not in this directory**,
and the exception is what defines it: it covers the stretch before any module
has evaluated, so `src/ui/` could not draw it — the bundle it would be drawn by
is what the player is waiting for. It is markup in `index.html` with its styles
in that file's `<style>` block, and `main.ts` is the only code that touches it:
taken down two frames after the `Game` constructor returns, or turned into the
"needs WebGL2" message when the game cannot start at all. It is self-contained
by necessity — in DEV `base.css` is injected from JS and has not arrived either,
so it may not use `--font`, `.frame`, or anything else the interface shares.
Nothing that reacts to game state may be added to it; that is an interface, and
it belongs here with a stylesheet of its own.

Each screen builds its own root element and appends it to `#hud`, which is why
construction order in `Game`'s constructor matters exactly once: `HUD` writes
`#hud.innerHTML` and would wipe anything already appended, so it is built first.
Stacking is not DOM order — `#overlay` (10), `#loadout` and `#lobby` (11) and
`#settings` (12) carry z-indices, because a pause can be taken with the deploy
map on screen. The kit and the lobby share a rung on purpose: both are lids
raised from the main menu and the two can never be up together.

**A list-shaped screen keeps its cursor by IDENTITY, not by index.** The lobby
is the one whose rows come and go under it — a refresh inserts matches ABOVE the
actions — and an index carried across a rebuild silently means a different row:
press Refresh, let a match appear, press Enter and you have created a match
instead, with the highlight having moved under your hand to say so. `sameRow`
matches an action by kind and a match by id, never by anything that changes
(a count going 3 → 4 is the same row). The settings screen is spared this only
because its rows are a static table.

**The four cards are one class because they are one element** — they share the
shell, the title block, the controls table and the Deploy button. The bar for a
screen of its own is *state*: the deploy map has a selection and a canvas, the kit
screen has two slots and a turntable; a card that is markup plus a button has not
earned one.

**The building card is the fourth, and it is the only one the player cannot
act on.** It stands over the ~0.7 s of merges, occlusion bake and nav grid that
building a map costs, and it exists because a freeze and a load look identical
from the outside — before it, the card the player had just confirmed simply
stopped where it stood for the whole build. `Game.startRound` is what actually
buys it the frame it needs to be drawn in; see the state machine's `loading` in
[`CLAUDE.md`](../CLAUDE.md), and note that the rule there is **two**
`requestAnimationFrame`s, not one. It takes itself down at the end of
`Game.buildRound` rather than waiting to be dismissed.

**Its bar may only be animated with `transform` or `opacity`** — the one place
in this directory where the choice of animated property is a correctness
constraint rather than a matter of taste. For the whole life of that card the
main thread is inside the build, so nothing on it can move unless the
COMPOSITOR can move it alone, and the compositor only takes an animation that
needs neither layout nor paint. A bar animated on `width` or `left` renders
perfectly in every test and then stands still for the one second it exists for,
which reads as a hung game rather than a loading one. Measured: with a 5 s
block forced, the bar keeps producing distinct frames throughout and drops
none. The bar is also **indeterminate**, and honestly so — the work behind both
it and the boot screen's is a single uninterruptible call, so there is no
progress to read even in principle, and an invented percentage always ends up
stuck at 90 while the real work finishes.

**The settings list is a ROW TABLE, and every row is the same thing: a labelled
choice over one field of `Settings`.** A toggle is a two-option choice, so Off/On
and a three-rung resolution ladder go through one renderer, one key handler and
one hit-testing path. What a longer list changes is only how the cell is DRAWN:
the control column is fixed, which is ~60 px a button for three options and 10 px
for sixteen — narrower than one character — so a row can ask for
`style: "slider"` and be laid along a track instead.

- **The slider is positioned by option INDEX, not by value**, one rung per equal
  share of the track. That is what keeps it a choice over the same `options` the
  arrow keys step and the same list a codec validates against: a drag cannot land
  on a value a keypress could not reach. It also preserves a ladder's spacing —
  `CONFIG.camera.lookScales` is geometric, so an inch of drag is the same *ratio*
  of look speed wherever it is taken.
- **The drag lives on the WINDOW and its geometry is captured at the press**,
  because `draw` rebuilds `innerHTML` wholesale: the element under the finger is
  destroyed and replaced the first time the value crosses a rung, and a listener
  or a pointer capture bound to it dies one rung in. The track's box is measured
  once — nothing about the row's layout depends on the value — so a drag survives
  the redraw, leaving the row, and running off the end of the screen.
- **The thumb's size is declared in CSS and read back off the DOM**, never
  restated in the script. Both the paint (`left: calc(var(--t) * (100% -
  var(--thumb)))`) and the hit maths need it, and two copies of that number are
  two things that drift into a thumb sitting where the value is not. The script
  writes `--t` and nothing else.
- **Hover does not move the selection while a slider is held.** The redraw a drag
  causes lands a fresh row under a pointer that has not moved between rows, and
  taking the selection from it would walk the highlight onto a slider the player
  is not dragging.

**A hint says what the value WORKS OUT TO, and that is why hints are computed
rather than written in the table.** "75%" and "1.25x" are both numbers over
something the screen never shows — a panel's pixel count, a rate in radians —
so `hintFor` resolves each against the machine (`1280x800`) or against
`CONFIG.camera` (`202° per 1000 px`, `160°/s at full stick`). A player comparing
this game against the shooter they came from is comparing sweeps, not
multipliers.

**A class on `#hud` belongs to whoever raises it.** `OverlayScreen` sets
`.overlaid`, `LoadoutScreen` sets `.kitting`, `HUD` sets `.paused`, `.editing` and
`.dying`. That is why a pause is two calls from `Game` rather than one: the card
goes up and the crosshair comes down, and they are not the same decision —
`.overlaid` would take the tickets and vitals with it, which under a pause are
still true.

**The magazine strip is markup the WEAPON TABLE sizes**, and it is the one place
a number in `CONFIG.weapons` reaches the DOM. `HUD.setAmmo` builds one `<i>` per
round in the carried weapon's magazine — the count is what makes the strip
readable without reading the number — so the row's length is a weapon's
`magSize` and a new weapon can make it any width it likes. The box is therefore
FIXED at the health bar's 224 px and the ticks are fitted into it: the pitch
gives way, never the count, and never the strip's own width, which would
otherwise redraw the right-hand column every time the kit changed. Ticks keep
their authored 5 px until a magazine is bigger than 32 rounds; the LMG's belt of
75 is what closes them up.

**Past a 3 px tick the strip takes a second ROW rather than closing up further**,
because 75 rounds in one row is a 2 px tick behind a 1 px gap — a bar with a
texture, which is the one thing the strip exists not to be. The threshold is that
measurement and not a round number, so a future magazine earns the row by being
unreadable without one; today only the belt qualifies, and the SMG's 34 still
draws as one row. The second row is paid for out of the tick's HEIGHT, inside the
same 13 px box, or the ammo count and the weapon label under it would move every
time the kit changed — the whole point of fixing the box. **The rows are filled
by COLUMN, not by line**: consecutive rounds are the top and bottom of one
column, so the lit fraction of the strip is still the fraction of the magazine
left, which is the reading every one-row weapon gives and the only reason a
second row is allowed at all. Filled by line, the top row would stay full until
the belt was half gone.

**The stowed slot is the only thing on screen that says the second weapon
exists.** Everything else in the bottom-right corner describes the weapon in
the hands — the viewmodel shows one gun, the big count counts one magazine, the
strip is one magazine's ticks — so a player who never pressed the swap key had
nothing telling them there was a key to press, and a sidearm nobody knows about
is a sidearm nobody draws when the rifle runs dry. That is the whole of what it
is for, and it decides how it is drawn.

- **It shares the ammunition LINE rather than taking a row of its own**, at the
  far left of it, in the space a two- or three-digit number was already leaving
  empty. The line is spread across the same 224 px as the health bar, the strip
  and the kit caption, so the second slot costs the corner no height and no
  width — it is drawn in a hole that was already there. Two slots on one line,
  the carried magazine shouting at the right end and the slung one murmuring at
  the left, is the hierarchy stated as a layout instead of as a caption.
- **Three parts, each at its own weight, and the KEY is the brightest.** The
  group is not dimmed as a whole: the chip is the instruction and is drawn dark
  on near-white to be read at a glance (a hint you have to squint at is a hint
  nobody follows), the count is the fact you act on, and the name is only there
  to say which weapon the other two are about. It gets **no strip of its own** —
  a second row of ticks beside the magazine's is two instruments competing to be
  read, and a count is enough for a weapon you are not firing.
- **It carries a live count, not a capacity.** Each slot keeps its own magazine
  ([`weapons.md`](weapons.md)), so what is slung is what you would be swapping
  *to* — pushed every frame like the carried one, each write skipped while its
  string has not moved.
- **Two states raise its voice, and they are opposites.** `dry` is the slung
  magazine being empty too, the mirror of `#ammo-mag.low`: a swap will not save
  you. `ready` is there being nothing to fire in your hands (empty *or*
  reloading) while there is here — the one moment in a round when the second
  slot is the whole answer, since a draw is a third of a second where a reload
  is one and a half. **`ready` is a handover, not an alarm**: the carried
  readout already dims itself through a reload, so the stowed slot coming up as
  that goes down reads as the corner pointing at the faster option, and it earns
  no animation on top. Firing the last round starts a reload in the same call,
  so "empty and not reloading" is a state the HUD would never get a frame of —
  which is why `ready` counts the reload rather than excluding it.
- **The name and the key turn over with the hands, through `Game.applyCarry`**
  — the same push that moves the kit caption, so the two can never disagree
  about which weapon is which. `Player.slungSlot + 1` is the digit on the chip,
  which is the same one fact `drawSlot` and the `1`/`2` keys already share.

**One stylesheet per module that writes markup, imported by that module**
(`HUD.ts`→`hud.css` … `editor/EditorPanel.ts`→`editor/panel.css`); `main.ts`
imports `base.css` first. Vite bundles them into one hashed stylesheet the built
`index.html` links from its head. All of it was once ~2,050 lines inline in
`index.html`, which cost three things worth not paying again: no compile-time link
between markup and the rules styling it, so a renamed class was a silent visual
break; the editor's ~170 lines shipped in every production build; and a CSS-only
change moved no content-hashed filename. Three rules keep it that way:

- **`base.css` is for what two or more screens share** — the reset, the canvas, the
  `#hud` root, `.frame`, `.brackets`, `.hidden`, the `--ov-scale` short-viewport
  block, `@keyframes pulse`, and the kit button. A rule only one screen uses belongs
  in that screen's sheet however tempting the shared file is.
- **A screen's state rules go with whoever sets the class**, not whoever owns the
  element: `#hud.paused #deploy { opacity: 0.18 }` is in `hud.css` because
  `HUD.setPaused` puts `.paused` on, even though `#deploy` is the deploy screen's.
- **`index.html` gets no interface CSS, ever, with exactly two exceptions**, and
  both are there because they are what the page shows while there is no
  interface. The first is a black `html, body` background: a production build
  links the stylesheet render-blocking from the head, but the dev server injects
  it from JS, leaving one frame of default white — on a night game that reads as
  a camera flash. The second is the boot screen's own block, for the same reason
  one step further along. Neither may grow a rule that styles anything a module
  writes, and nothing else may be added beside them.

## Getting into a round

Four screens stand between the title and the world, each driven by a pointer
*and* by a pad, with no path that needs the other. The fourth is the lobby, and
it is the one that is optional: it is how a NETWORKED round is chosen, and
picking a match out of it leaves through `startRound` exactly as Deploy does —
a networked round and a single-player one are the same `loading -> deploy ->
playing` cycle, differing only in whether `Game.net` exists.

**Every screen here is a LIST: move the cursor, A picks, B backs out.** That
replaced a screen per verb — left/right for difficulty, `L`/Y for the kit, `O` for
settings — which is a keyboard's idea of a menu: every action needs its own button,
and an action nobody found a button for is one a pad cannot reach (the settings
screen was exactly that). The dedicated keys survive as accelerators; none is the
only way in.

- **The cursor is `OverlayScreen`'s, and it is a class on rows that already
  exist.** `MENU_ITEMS` is the list, `activateMenu` is what A fires, and the mark is
  a caret on the label plus a ring on the control — never a fill, since the tier
  buttons and Deploy button are *already* filled hot to say what is chosen. **The
  ring has to be INSET on anything chamfered**: every button here is cut by a
  `clip-path`, which clips its own element's outline and box-shadow along with the
  corner, so an offset outline draws on the tier group (a plain div) and silently on
  nothing else.
- **A / Enter fire the cursor's row and BREAK; Start still starts the round from
  anywhere.** Both flags come up on the same frame for A, so the order is the whole
  mechanism — without the break, A on the settings row opens the screen and then
  deploys the player out from under it.
- **THE POINTER DEPLOYS ONLY THROUGH THE DEPLOY BUTTON**, on this card and the
  round-over one. `confirmPressed` was "a button went down anywhere", mouse and
  finger alike, which is fine on a card that is only a title and wrong the moment
  the menu grew controls: the map and difficulty rows fire on the click's mouse-UP
  while the confirm reads the mouse-DOWN a tick earlier, so **choosing a map or a
  difficulty started the round on the same press**. Neither flag carries a pointer
  now; the button carries the mouse and the tap by itself. Restoring a
  click-anywhere confirm to a screen that has controls on it restores that bug.
- **The cursor survives a redraw and resets when the card is RAISED**
  (`OverlayScreen.card`). `showMenu` is called again on every difficulty change and on
  the way back from the kit and settings screens; a cursor that jumped home each time
  would make the row you just left the one place you cannot stay.

**The LEFT STICK drives all of it, and holding a direction repeats.** It is the
left stick alone (the right one turns the kit turntable), read raw against
`input.menuStickThreshold` rather than through the movement deadzone, because a menu
step is discrete and a stick resting a third of the way over must not scroll a list.
`InputManager` folds keys, d-pad and stick into two DIRECTIONS rather than four
buttons, so opposing presses cancel and a diagonal resolves into one step per axis;
`stepNav` turns a held direction into the edge-and-repeat the menus read. The repeat
is what makes a stick usable (it has no detent to tap) and deliberately does not
extend to confirm or back.

**Each screen has ONE content width and everything hangs off it.** `#overlay`
declares `--col` (settings grid, Deploy button, controls table, pause list, result
bar) and `#deploy` declares `--map` (status line, hint row, button row, so they meet
the map's edges). The two big titles are the deliberate exception.

- **The menu's two settings rows are one grid, not two rows.** Centred
  independently they put labels, controls and hints at three different x each.
  `.ov-settings` owns the three columns and each row is `display: contents`. The
  control column is `1fr`, so the four difficulty tiers and the kit button span the
  same width — which sets the tiers' padding, since at 18px their min-content
  overflowed `--col` at every viewport size.
- **Only the controls opt into pointer events, never the rows.** `#hud` is
  `pointer-events: none` and the menu's confirm is a mouse-down anywhere, so a row
  that claimed events would turn its labels, hints and the grid's gaps into dead zones
  where a click does nothing instead of starting the round.
- **`#deploy-actions` wraps.** The map is height-led, so on a 768-tall laptop it is
  430 px across and the longest kit ("Marksman rifle · Scope") does not fit beside a
  Deploy button. Both buttons grow, so a broken row gives two full-width buttons
  stacked rather than one hanging over the map's edge. That width is also why every
  input hint lives in the one hint row.

**The menu and round-over card carry a `Deploy` button**
(`OverlayScreen.bindStart` → `Game.onStart`), and it is the **only** thing on either
card a pointer can deploy with. It began as a redundant target beside a
click-anywhere confirm, which is why it exists at all: an instruction in prose is not
a target, and "click, press Enter, or press Start" made a pad player work out which
was theirs. It now carries the mouse and the finger by itself. It is also where the
menu's cursor starts, keeping Enter and A meaning "start the round" the moment the
title appears.

**That button is why the deploy screen's confirm is `menuConfirmPressed`.** It
changes state on the down edge, which puts the `deploy` branch in front of the very
click that asked for it — and the first deploy of a round has `respawnT` at 0, so a
confirm counting the mouse fired immediately and dropped the player in at whichever
spawn the list started on, skipping the screen. Enter and pad A only; the map takes
its own clicks and the two buttons take their own.

**The spawn is steppable** (`DeployScreen.moveSelection`, wired to the menu
directions in `Game`'s `deploy` branch, so the stick steps it too). Both axes step
the same list: the spawns are points scattered over a map rather than a row or
column, so no direction *means* anything, and a direction that does nothing reads as
a screen ignoring the pad. The selection is stepped *before* `update()` redraws, so
the marker and the status line — which names the selection, because a highlight
300 px away is not a label — move on the frame the key was pressed.

**`#deploy-go` is the pointer's way off that screen**, since the confirm no longer
takes a click. Pointerdown, like the map's markers: the same event goes on to take
the pointer lock, which it can only do once `spawnPlayer` has moved the state to
`playing`. It greys itself (`.waiting`) while `confirm()` is still a no-op.

**The right half of the kit screen is a turntable carrying the real viewmodel.** It
is not a second model, not a render target and not a second camera: `ViewModel`
simply has a pose that is not the carried one (`beginInspect` / `spinInspect` /
`updateInspect` / `endInspect`), and the weapon is already parented to the camera
and drawn in `VIEWMODEL_GROUP`.

- **The stage is a hole in the screen's scrim.** Everything the kit screen draws is
  DOM and DOM is above the canvas, so a backdrop over the stage would dim the weapon
  along with the world. `#loadout`'s scrim stops at the panel column and the stage
  gets a vignette instead; `show()` marks `#hud` so the CSS can hide the menu, the
  deploy map and every gauge while the kit is up.
- **What the weapon is read against is therefore in the SCENE, not in the
  stylesheet**, and the vignette's first stop is fully transparent because of it.
  It used to open at alpha 0.5 over the middle of the stage — where the weapon is
  — so the frame was drawing the one thing the screen exists to show at half
  strength, and the map behind it at half strength too, which is a contrast
  problem the DOM cannot solve from the wrong side of the canvas. The dark card
  now behind the weapon (`CONFIG.viewmodel.inspect.backdrop`,
  [`weapons.md`](weapons.md)) is what holds the map down; the vignette is left
  closing the corners of the bay and nothing else.
- **The stage's geometry is shared with `CONFIG.viewmodel.inspect`.** The pose is
  placed by back-projecting a SCREEN anchor, and the anchor works out to exactly the
  CSS `--panel` fraction (the stage's centre is `(1+p)/2` across, which in NDC is
  `p`). Both are fractions of the viewport, so a resize moves them together; the
  distance additionally gives way on a viewport narrower than `aspectReference`,
  because apparent size follows the vertical FOV while the room to fit in is a share
  of the width.
- **The turntable rotation is a quaternion, and the only thing allowed to write
  one.** The carried pose is Euler, composed in the weapon's own frame, so at a
  side-on yaw the pitch a drag asks for arrives as a roll. `endInspect` dropping the
  quaternion is what lets the Euler pose come back at all — while one is set Babylon
  ignores `rotation` entirely.
- **It rotates about a derived pivot, not the node's origin** (which on a rifle is
  the receiver — a turntable about that would swing the weapon around the screen).
  `applyFit` measures the pivot from the weapon's own muzzle landmark.
- **The hands let go.** A forearm cut off at the elbow reads fine on a carried
  weapon and as a severed arm on a bench, so `ViewModel` hides the arm meshes for the
  duration — one place writes mesh visibility.

`Game.updateKitStage` drives it, because `loadout` is the one lid state showing live
3D and owes by hand the per-frame pushes only `updateGameplay` makes. The camera
position is the load-bearing one — the cel shader fogs against `camPos`, which
outside a round is whatever the last gameplay frame left and `Vector3.Zero()` before
the first, so a kit opened off the main menu would fog the weapon to a grey
silhouette. It also puts up the two bench lamps (`CONFIG.lighting.kitLamps`),
through `LightingSystem` like every other light because a carried light always wins
a slot; they are far brighter than the shoulder lamp on purpose, since moonlight
alone on a night game's albedo is a black silhouette. `stowKit` is the single
teardown — screen, pose and lamps — and all four exits go through it, because a
carried light nobody removes survives `lighting.clear()` and follows the player into
the round.
