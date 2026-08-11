# The interface: four screens and the chrome

What each UI class owns, where a stylesheet lives, and how the three screens
between the title and the world are driven by a pointer and a pad alike. Split out
of [`CLAUDE.md`](../CLAUDE.md), which keeps the summary; this file is the
contract for everything under `src/ui/`.

## The interface is four screens and the chrome

`src/ui/` holds one class per thing on screen, and `HUD` is not where a new one
goes: `OverlayScreen` owns the three full-screen cards, `DeployScreen` the deploy
map, `LoadoutScreen` the kit, `SettingsScreen` the toggles, `Minimap` the corner
map, and `HUD` **only** the gameplay chrome.

Each screen builds its own root element and appends it to `#hud`, which is why
construction order in `Game`'s constructor matters exactly once: `HUD` writes
`#hud.innerHTML` and would wipe anything already appended, so it is built first.
Stacking is not DOM order — `#overlay` (10) and `#loadout` (11) carry z-indices,
because a pause can be taken with the deploy map on screen.

**The three cards are one class because they are one element** — they share the
shell, the title block, the controls table and the Deploy button. The bar for a
screen of its own is *state*: the deploy map has a selection and a canvas, the kit
screen has two slots and a turntable; a card that is markup plus a button has not
earned one.

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
- **`index.html` gets no interface CSS, ever.** The one inline rule is a black
  `html, body` background: a production build links the stylesheet render-blocking
  from the head, but the dev server injects it from JS, leaving one frame of default
  white — on a night game that reads as a camera flash.

## Getting into a round

Three screens stand between the title and the world, each driven by a pointer *and*
by a pad, with no path that needs the other.

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
