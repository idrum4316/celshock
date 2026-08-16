/**
 * InputManager.ts — Unified keyboard/mouse + gamepad input state, plus gamepad
 * haptics (rumble()).
 * Owns: raw event listeners, the per-frame public fields (move/look/actions)
 * that Game and CameraSystem read, and the GamepadHapticsActuator pulses.
 * Invariants: update() must be called exactly once per frame — it composes
 * state and RESETS accumulators and edge-triggered flags (jumpPressed,
 * reloadPressed, confirmPressed, ads). Anything that assigned those fields
 * externally is overwritten next tick (this bites headless test scripts).
 * rumble() must stay a silent no-op when there is no pad, no actuator, or
 * the effect is rejected — haptics are a garnish, never a failure path.
 * Every key this file binds is listed in BOUND_CODES and has its browser
 * default suppressed; a new binding that is not added there will fight the
 * browser (Ctrl+letter combinations especially — crouch is Ctrl).
 */
import { CONFIG } from "../config";

/**
 * Unified input for keyboard/mouse and gamepad (Xbox/PlayStation standard
 * mapping). Call `update()` exactly once per frame, then read the public
 * state fields. Mouse deltas are accumulated between frames and consumed
 * on each update.
 */
export class InputManager {
  // --- composed per-frame state (read these) ---
  /** Strafe axis, -1 (left) .. 1 (right). */
  moveX = 0;
  /** Forward axis, -1 (back) .. 1 (forward). */
  moveY = 0;
  /** Mouse look delta in pixels for this frame. */
  mouseLookX = 0;
  mouseLookY = 0;
  /** Gamepad right-stick deflection, -1..1. */
  stickLookX = 0;
  stickLookY = 0;
  ads = false;
  /** Held: trigger. See `consumeFire()` for the release latch. */
  fire = false;
  jumpPressed = false;
  reloadPressed = false;
  /**
   * Edge-triggered "throw a grenade" (G / gamepad RB).
   *
   * Edge rather than held, unlike the trigger: there is no automatic fire for
   * grenades and you carry two, so a held button that emptied the pouch in two
   * frames would be a bug rather than a feature. RB is the pad's home for it
   * because it is the one shoulder button nothing else claims — LT aims, RT
   * fires, LB is still free and RB is where every shooter puts this.
   */
  grenadePressed = false;
  /**
   * Edge-triggered "swap to the other weapon" (mouse wheel / gamepad Y).
   *
   * The wheel is where a keyboard-and-mouse player already reaches for this,
   * and it costs nothing: the weapon is the only thing in this game a wheel
   * could mean, and there is no page under the canvas to scroll. It is a
   * TOGGLE rather than a cycle because there are exactly two slots — a notch
   * either way is "the other one", so there is nothing for a direction to
   * select. The numbers below are the way to name a slot outright.
   *
   * Gameplay only, which is what makes Y available for it on the pad: the
   * fourth face button already opens the loadout (`loadoutPressed`), and that
   * flag is read in the menu and deploy states only. The two never come up in
   * the same state, so one button carries both — exactly the arrangement B
   * already has as crouch and back, and for the same reason.
   */
  swapPressed = false;
  /**
   * Edge-triggered "draw THIS weapon": 0 for the primary (`1`), 1 for the
   * sidearm (`2`), and -1 for no request this frame.
   *
   * A slot index rather than a swap, because that is the whole difference: the
   * wheel asks for the other weapon and these ask for a particular one, so a
   * player who has lost track of what is in their hands can press `1` and know
   * what they get. Pressing the one already carried does nothing at all —
   * re-drawing the weapon you are holding is half a second of animation in
   * exchange for no change.
   */
  slotPressed = -1;
  /**
   * Keyboard: held Shift. Gamepad: L3 toggles — holding a stick click for a
   * 240 m crossing is miserable, so the pad latches instead.
   *
   * This is the ASK, not the sprint: whether one is happening also depends on
   * the stick, the optic and the reload, and `Player` is what resolves that.
   * It is also what spends the latch when the sprint ends
   * (`clearSprintToggle`), so a stop is a stop rather than a pause in a
   * standing intention to run.
   */
  sprint = false;
  /**
   * Crouch, from a hold OR a latch, because the two inputs want different
   * things. Ctrl is held: a crouch taken for a corner or a single burst, where
   * letting go is how you stand up and there is nothing to forget you are in.
   * `C` and the pad's B toggle, for the crouch you hold through a whole
   * firefight — and on the pad that is the only workable shape, since B is
   * also jump's neighbour and holding it rules out the rest of the face
   * buttons.
   *
   * The two toggles share ONE latch (`crouchLatched`), so whichever of them
   * put you down can be answered by either one, and Ctrl simply ORs on top —
   * a hold cannot clear a latch, and releasing it drops you back to whatever
   * the latch says.
   *
   * The latch is EXCLUSIVE with the sprint latch and is spent by a sprint
   * rather than suspended under one: see `clearCrouchToggle`.
   */
  crouch = false;
  /** Held: show the scoreboard. */
  scoreboard = false;
  /**
   * Edge-triggered "confirm" (Enter / gamepad A / Start).
   *
   * The POINTER IS DELIBERATELY OUT OF IT, mouse and finger alike. This was
   * once "a button went down anywhere", which is fine on a card that is only a
   * title and wrong the moment the menu grew controls: the map and difficulty
   * rows fire on the click's mouse-UP while this reads the mask on the next
   * tick, so picking either one deployed the player out from under the pick.
   * Both cards that read this carry a Deploy button, which is the pointer's way
   * off them — and a finger's, since it takes a tap like any other pointerdown.
   * Start stays: it is the pad's "start the game" wherever the cursor rests.
   */
  confirmPressed = false;
  /**
   * Edge-triggered confirm with START LEFT OUT as well (Enter / gamepad A).
   *
   * Every screen with a cursor reads this one: Start is the pause key, and a
   * screen that let it fire the selection would answer the button that was
   * asking to leave. The pointer is out of both flags for the reason above —
   * these screens are lists of buttons, and a press on the empty half of one
   * is not a menu choice.
   */
  menuConfirmPressed = false;
  /**
   * Edge-triggered menu navigation (arrow keys / gamepad D-pad / LEFT STICK).
   * Menus only — nothing in gameplay reads these.
   *
   * The stick is here because a pad player reaches for it first and a menu
   * that only answers the d-pad reads as a menu that does not know a pad is
   * connected. It is the left stick alone: the right one turns the weapon on
   * the kit screen's turntable, and the left one means nothing in any state
   * that reads these flags.
   *
   * "Edge-triggered" is now an edge OR a REPEAT — held past
   * `input.menuRepeatDelay` these fire again every `menuRepeatInterval`. A
   * stick has no detent to tap, so a pure edge would make it a worse d-pad
   * rather than an alternative to one; the same repeat on the keys and the
   * d-pad is what everything else with a list does. Confirm and back are
   * deliberately NOT repeated — a held A must not fire a menu item twice.
   *
   * Opposing directions cancel: pressing both arrows is no step rather than
   * two that fight, which is also what resolves a stick sitting on a diagonal.
   */
  menuLeftPressed = false;
  menuRightPressed = false;
  menuUpPressed = false;
  menuDownPressed = false;
  /**
   * Edge-triggered "back out of this screen" (Backspace / gamepad B).
   *
   * Menus only, which is what makes B available at all: on the pad B is
   * crouch, and nothing in gameplay reads this flag. Escape is deliberately
   * NOT here — it is the pause key, and the screens that take a back also take
   * a pause, so folding the two together would leave no way to tell which the
   * player asked for.
   */
  menuBackPressed = false;
  /**
   * Edge-triggered pause/resume (Escape / gamepad Start).
   *
   * Escape is deliberately NOT in `BOUND_CODES`: its browser default is to
   * drop pointer lock, which is exactly what a pause wants, and a page cannot
   * suppress it anyway. It is also not the only trigger — a locked pointer is
   * the browser's to release, and some browsers swallow the keydown that
   * releases it, so `Game` pauses on losing the lock as well as on this.
   *
   * Start doubles as `confirmPressed` (it is the menus' "deploy" button), so
   * both flags come up on the same frame. Game resolves that by handling pause
   * first and ignoring the confirm behind it.
   */
  pausePressed = false;
  /**
   * Whether the keyboard pause key is physically DOWN, as opposed to the edge
   * above.
   *
   * The one place a held key matters outside gameplay: `Game` will not ask for
   * the pointer lock back while Escape is down, because the browser is still
   * treating that press as its own exit gesture and will take the lock away
   * again — the auto-repeat of a key held a beat too long is enough to do it,
   * and the round would put the pause menu back up on its own.
   */
  get pauseKeyHeld(): boolean {
    return this.keys.has("Escape");
  }
  /**
   * Edge-triggered "open the loadout" (L / gamepad X). Menus only: it is read
   * in the menu and deploy states and nowhere else, which is what keeps the
   * kit out of reach inside a round you are already standing in.
   */
  loadoutPressed = false;
  /**
   * Edge-triggered "open the settings" (O). Keyboard only, deliberately: the
   * face buttons are all spoken for (A confirms, B backs out and crouches, X
   * reloads, Y opens the kit), and a pad reaches the screen by putting the
   * menu's cursor on its row and pressing A, or through the pause list. That
   * cursor is why this being keyboard-only is now a shortcut rather than a
   * hole — before it, the settings screen was the one thing on the menu no
   * pad could open at all. Read in the menu, deploy and paused states —
   * settings are reachable from a held round where the kit is not, because
   * turning the blur off is a thing you judge against a live scene.
   */
  settingsPressed = false;
  /**
   * The multiplayer lobby's key, `M`. Keyboard-only for the same reason
   * `settingsPressed` is: the menu cursor reaches the row, so a dedicated key
   * is an accelerator rather than the only way in, and a pad has no button
   * spare that is not already a menu verb. Read in the `menu` state alone —
   * the lobby is a lid over the title card and nowhere else.
   */
  multiplayerPressed = false;
  pointerLocked = false;
  gamepadConnected = false;
  /**
   * Held: the modifier key. No gameplay meaning — the map editor uses it to
   * suspend grid snapping. Read per frame rather than latched so a keyup lost
   * to a window blur cannot leave it stuck on (blur clears the key set).
   */
  altHeld = false;
  /**
   * True this frame when any pad axis (past the deadzone) or button is
   * active. This is what lets aim assist tell "player is driving the pad"
   * apart from "pad is idle on the desk while the mouse does the aiming".
   */
  padActive = false;

  // --- internals ---
  private keys = new Set<string>();
  /**
   * Button state as a `buttons`-style bitmask (1 = left, 2 = right,
   * 4 = middle), tracked from BOTH pointer events and compatibility mouse
   * events. Browsers deliver one or the other reliably depending on
   * pointer lock and preventDefault quirks, so we OR the two sources.
   */
  private pointerMask = 0;
  private mouseMask = 0;
  private accumX = 0;
  private accumY = 0;
  private prevJump = false;
  private prevReload = false;
  private prevGrenade = false;
  private prevSwap = false;
  private prevSlot = -1;
  /**
   * Wheel travel since the last `update()`, normalised to pixels and consumed
   * on read — the same shape as the mouse-look accumulator above, and for the
   * same reason: a frame that never ran must not be able to spend two notches.
   */
  private wheelAccum = 0;
  private prevConfirm = false;
  private prevMenuConfirm = false;
  /** The two menu axes' held direction and repeat clock. See `menuLeftPressed`. */
  private navX: NavAxis = { dir: 0, next: 0 };
  private navY: NavAxis = { dir: 0, next: 0 };
  private prevMenuBack = false;
  private prevPause = false;
  private prevLoadout = false;
  private prevSettings = false;
  private prevMultiplayer = false;
  private prevPadSprint = false;
  private prevCrouchToggle = false;
  /** Latched L3 sprint state — toggled on each L3 press, cleared on blur. */
  private padSprintOn = false;
  /**
   * Latched crouch — flipped by `C` or by the pad's B, cleared on blur and by
   * `clearCrouchToggle()`. One latch for both, see `crouch`.
   */
  private crouchLatched = false;
  /** Set by `consumeFire()`; cleared the frame the trigger reads released. */
  private fireBlocked = false;

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (BOUND_CODES.has(e.code) && !isTyping(e.target)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.pointerMask = 0;
      this.mouseMask = 0;
      this.padSprintOn = false;
      this.crouchLatched = false;
      this.wheelAccum = 0;
      // A direction held when focus was lost must not repeat on the way back:
      // the keys are gone above, but the axis still believes it is held down
      // and would fire the moment its repeat clock came round.
      this.navX.dir = 0;
      this.navY.dir = 0;
    });

    // Button state is read from `buttons` bitmasks (not individual
    // pointerdown events) because chorded presses — e.g. left-click while
    // right-click ADS is held — only arrive as a pointermove per the spec.
    // Only mouse-type pointers may drive button state — a stray touch or
    // pen event must not clobber a held mouse button. (Synthetic
    // PointerEvents report pointerType "" and are accepted.)
    const isMouse = (e: PointerEvent) => e.pointerType === "mouse" || e.pointerType === "";
    const readPointer = (e: PointerEvent) => {
      if (isMouse(e)) this.pointerMask = e.buttons;
    };
    // A touch is felt nowhere in here, and does not need to be: every screen a
    // phone meets carries its own button (the menu's and the round-over card's
    // Deploy, the deploy screen's map and `#deploy-go`, the kit screen's), each
    // listening for its own `pointerdown`. A tap latched into `confirmPressed`
    // is what used to get past the title screen, and it deployed the player off
    // the map and difficulty rows on the way — see `confirmPressed`.
    document.addEventListener("pointerdown", readPointer);
    document.addEventListener("pointerup", readPointer);
    document.addEventListener("pointercancel", (e) => {
      if (isMouse(e)) this.pointerMask = 0;
    });
    document.addEventListener("mousedown", (e) => {
      this.mouseMask |= mouseButtonBit(e.button);
    });
    document.addEventListener("mouseup", (e) => {
      this.mouseMask &= ~mouseButtonBit(e.button);
    });
    document.addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener("pointermove", (e) => {
      if (!isMouse(e)) return;
      this.pointerMask = e.buttons;
      if (this.pointerLocked) {
        this.accumX += e.movementX;
        this.accumY += e.movementY;
      }
    });
    // The wheel. Passive, and deliberately not prevented: nothing on this page
    // scrolls (the canvas fills the viewport and `#hud` is fixed), so the
    // browser default is already a no-op where it matters — while the map
    // editor's inspector is a panel full of number inputs that a wheel is
    // supposed to be able to scroll past. Accumulated rather than read as an
    // event, because a trackpad delivers a dozen of these per frame.
    //
    // `deltaMode` is normalised here rather than at the read: the same gesture
    // reports pixels in Chrome, LINES in Firefox and pages on some setups, and
    // a threshold compared against three different units is a threshold that
    // works on one browser.
    window.addEventListener(
      "wheel",
      (e) => {
        const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
        this.wheelAccum += e.deltaY * scale;
      },
      { passive: true },
    );

    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === canvas;
      // Escape is the browser's own gesture for dropping the lock, and the
      // keyup that follows it can land on a different focus target. Clearing
      // the key here means a swallowed keyup cannot leave the pause key stuck
      // down, which would eat every later press of it.
      this.keys.delete("Escape");
    });
  }

  /** Composes the frame's input state from keyboard, mouse, and gamepad. */
  update(): void {
    const pad = this.readGamepad();
    this.gamepadConnected = pad !== null;
    const dz = CONFIG.input.deadzone;
    const trig = CONFIG.input.triggerThreshold;

    // Movement
    let kx = 0;
    let ky = 0;
    if (this.keys.has("KeyA")) kx -= 1;
    if (this.keys.has("KeyD")) kx += 1;
    if (this.keys.has("KeyW")) ky += 1;
    if (this.keys.has("KeyS")) ky -= 1;
    let px = 0;
    let py = 0;
    if (pad) {
      px = applyDeadzone(pad.axes[0] ?? 0, dz);
      py = -applyDeadzone(pad.axes[1] ?? 0, dz);
    }
    this.moveX = clamp(kx + px, -1, 1);
    this.moveY = clamp(ky + py, -1, 1);

    // Look
    this.mouseLookX = this.accumX;
    this.mouseLookY = this.accumY;
    this.accumX = 0;
    this.accumY = 0;
    this.stickLookX = pad ? applyDeadzone(pad.axes[2] ?? 0, dz) : 0;
    this.stickLookY = pad ? applyDeadzone(pad.axes[3] ?? 0, dz) : 0;

    // Actions (LT=6 ADS, RT=7 shoot, RB=5 grenade, A=0 jump, B=1 crouch,
    // X=2 reload, L3=10, Start=9)
    const padAds = pad ? buttonHeld(pad, 6, trig) : false;
    const padFire = pad ? buttonHeld(pad, 7, trig) : false;
    const padGrenade = pad ? buttonHeld(pad, 5, trig) : false;
    const padJump = pad ? buttonHeld(pad, 0, trig) : false;
    const padCrouch = pad ? buttonHeld(pad, 1, trig) : false;
    const padReload = pad ? buttonHeld(pad, 2, trig) : false;
    // Y/Triangle. Two jobs on two disjoint sets of states — the kit screen out
    // of a menu, the weapon swap inside a round — read once here so they cannot
    // disagree about the button.
    const padLoadout = pad ? buttonHeld(pad, 3, trig) : false;
    const padStart = pad ? buttonHeld(pad, 9, trig) : false;
    const padSprint = pad ? buttonHeld(pad, 10, trig) : false;

    this.padActive =
      pad !== null &&
      (px !== 0 ||
        py !== 0 ||
        this.stickLookX !== 0 ||
        this.stickLookY !== 0 ||
        padAds ||
        padFire ||
        padGrenade ||
        padJump ||
        padCrouch ||
        padReload ||
        padStart ||
        padSprint ||
        buttonHeld(pad, 8, trig));

    const buttons = this.pointerMask | this.mouseMask;
    this.ads = (buttons & 2) !== 0 || padAds;
    // The trigger is held, not edge-triggered — full-auto depends on it — so a
    // suppressed press is cleared by the release rather than by a timer.
    const fireNow = (buttons & 1) !== 0 || padFire;
    if (!fireNow) this.fireBlocked = false;
    this.fire = fireNow && !this.fireBlocked;

    // L3 toggles sprint rather than holding it — a stick click is fatiguing
    // to hold, and sprint here is traversal, not a burst. Taking one latch
    // spends the other: the two stances are exclusive, so the one asked for
    // second wins outright rather than queueing behind the first.
    if (padSprint && !this.prevPadSprint) {
      this.padSprintOn = !this.padSprintOn;
      if (this.padSprintOn) this.crouchLatched = false;
    }
    this.prevPadSprint = padSprint;

    this.sprint =
      this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") || this.padSprintOn;

    // Crouch: `C` and pad B flip the shared latch on their rising edge, Ctrl
    // is held on top of whatever the latch says. Both toggles are OR'd into
    // one edge, so pressing them on the same frame is one flip rather than
    // two that cancel.
    const crouchToggleNow = this.keys.has("KeyC") || padCrouch;
    if (crouchToggleNow && !this.prevCrouchToggle) {
      this.crouchLatched = !this.crouchLatched;
      // The other half of the exclusivity above: asking to get down ends a
      // latched sprint, so the crouch takes effect on the frame it was asked
      // for instead of waiting for the run to finish.
      if (this.crouchLatched) this.padSprintOn = false;
    }
    this.prevCrouchToggle = crouchToggleNow;
    this.crouch =
      this.crouchLatched ||
      this.keys.has("ControlLeft") ||
      this.keys.has("ControlRight");
    this.altHeld = this.keys.has("AltLeft") || this.keys.has("AltRight");
    // Back / View button (6 on the standard mapping is LT, 8 is Back).
    this.scoreboard = this.keys.has("Tab") || (pad ? buttonHeld(pad, 8, trig) : false);

    const jumpNow = this.keys.has("Space") || padJump;
    this.jumpPressed = jumpNow && !this.prevJump;
    this.prevJump = jumpNow;

    const reloadNow = this.keys.has("KeyR") || padReload;
    this.reloadPressed = reloadNow && !this.prevReload;
    this.prevReload = reloadNow;

    const grenadeNow = this.keys.has("KeyG") || padGrenade;
    this.grenadePressed = grenadeNow && !this.prevGrenade;
    this.prevGrenade = grenadeNow;

    // The weapon swap. `padLoadout` is Y, which this shares with the loadout
    // screen — see `swapPressed`. The pad half is edge-triggered because a held
    // button must not queue a second gesture behind the first; the wheel needs
    // no edge, since a notch IS one.
    //
    // The accumulator is spent whole rather than by the notch: three notches
    // inside one frame are still one request, because with two slots the
    // second notch would only undo the first.
    const wheeled = Math.abs(this.wheelAccum) >= CONFIG.input.wheelStep;
    this.wheelAccum = 0;
    this.swapPressed = wheeled || (padLoadout && !this.prevSwap);
    this.prevSwap = padLoadout;

    // …and naming a slot outright. Nothing on the pad: there is no button left
    // for it, and Y already reaches both weapons in the two presses this saves.
    const slotNow = this.keys.has("Digit1") ? 0 : this.keys.has("Digit2") ? 1 : -1;
    this.slotPressed = slotNow !== this.prevSlot ? slotNow : -1;
    this.prevSlot = slotNow;

    const confirmNow =
      this.keys.has("Enter") ||
      this.keys.has("NumpadEnter") ||
      padJump ||
      padStart;
    this.confirmPressed = confirmNow && !this.prevConfirm;
    this.prevConfirm = confirmNow;

    const menuConfirmNow =
      this.keys.has("Enter") || this.keys.has("NumpadEnter") || padJump;
    this.menuConfirmPressed = menuConfirmNow && !this.prevMenuConfirm;
    this.prevMenuConfirm = menuConfirmNow;

    // Menu navigation, from three sources folded into two axes: the arrow keys,
    // the d-pad (buttons 12/13/14/15 on the standard mapping) and the left
    // stick. Each axis is a direction rather than four independent buttons, so
    // opposing presses cancel and a diagonal stick resolves into one step per
    // axis. `stepNav` turns the held direction into the edge-and-repeat the
    // menus actually read — see `menuLeftPressed`.
    //
    // The stick is read RAW against its own threshold rather than through
    // `applyDeadzone`: a menu step is discrete, so what matters is whether the
    // stick is committed to a direction, not how far past the movement
    // deadzone it has travelled.
    const nt = CONFIG.input.menuStickThreshold;
    const stickX = pad ? (pad.axes[0] ?? 0) : 0;
    const stickY = pad ? (pad.axes[1] ?? 0) : 0;
    const held = (key: string, button: number, axis: number, sign: number) =>
      this.keys.has(key) ||
      (pad ? buttonHeld(pad, button, trig) : false) ||
      axis * sign > nt;
    const rawX =
      (held("ArrowRight", 15, stickX, 1) ? 1 : 0) -
      (held("ArrowLeft", 14, stickX, -1) ? 1 : 0);
    // Axis 1 is negative upward on the standard mapping, so "up" is the
    // negative half of the stick and of the resulting direction alike.
    const rawY =
      (held("ArrowDown", 13, stickY, 1) ? 1 : 0) -
      (held("ArrowUp", 12, stickY, -1) ? 1 : 0);
    const now = performance.now() / 1000;
    const navX = stepNav(this.navX, rawX, now);
    const navY = stepNav(this.navY, rawY, now);
    this.menuLeftPressed = navX < 0;
    this.menuRightPressed = navX > 0;
    this.menuUpPressed = navY < 0;
    this.menuDownPressed = navY > 0;

    // Back. `padCrouch` is B, and reading it here rather than a fourth face
    // button is the whole point: B is the back button everywhere else on a
    // console, and the states that read this one are states where nobody is
    // crouching.
    const backNow = this.keys.has("Backspace") || padCrouch;
    this.menuBackPressed = backNow && !this.prevMenuBack;
    this.prevMenuBack = backNow;

    const pauseNow = this.keys.has("Escape") || padStart;
    this.pausePressed = pauseNow && !this.prevPause;
    this.prevPause = pauseNow;

    // The loadout screen's own key. On the pad it is Y/Triangle — button 3 is
    // the one face button nothing else claims in a menu (A jumps and confirms,
    // B crouches, X reloads), and the loadout is only ever reachable from a
    // screen where the face buttons mean menu things anyway. In a round the
    // same button swaps weapons; see `swapPressed`.
    const loadoutNow = this.keys.has("KeyL") || padLoadout;
    this.loadoutPressed = loadoutNow && !this.prevLoadout;
    this.prevLoadout = loadoutNow;

    // The settings screen's key. No pad binding — see the field's note.
    const settingsNow = this.keys.has("KeyO");
    this.settingsPressed = settingsNow && !this.prevSettings;
    this.prevSettings = settingsNow;

    // The lobby's key. No pad binding, same reason.
    const multiplayerNow = this.keys.has("KeyM");
    this.multiplayerPressed = multiplayerNow && !this.prevMultiplayer;
    this.prevMultiplayer = multiplayerNow;
  }

  /**
   * Suppresses `fire` until the trigger is physically released, so a button
   * still held from a UI click cannot discharge the gun.
   *
   * This exists because the deploy map's click is BOTH the UI click and the
   * gesture that acquires pointer lock: `DeployScreen` spawns the player on
   * pointerdown, the same event bubbles to `Game`'s document listener which —
   * now that the state is "playing" — locks the pointer, and the held button
   * then satisfies the `pointerLocked` fire gate on the very next frame. The
   * gate assumes UI clicks happen while unlocked; this is the one that does
   * not. A timed lockout would be wrong: it would be frame-rate dependent and
   * would also eat a deliberate first shot from a fast player.
   *
   * The latch is set unconditionally rather than from the current `fire`,
   * which is a frame old here — callers run inside an event handler, between
   * two `update()`s. If nothing was held, the next `update()` clears it and
   * the call cost nothing.
   */
  consumeFire(): void {
    this.fireBlocked = true;
  }

  /**
   * Drops the latched crouch, so the player stands up. Held keys are
   * untouched — a Ctrl still down is still a crouch on the next frame.
   *
   * Two callers, for two different reasons. `Player` spends the latch when a
   * sprint actually starts (see `LATCH IS SPENT` there). And `Game` calls it
   * wherever a B press hands control back to gameplay, plus on spawn: B is
   * both the pad's crouch toggle and its "back", so the press that backs out
   * of a screen flips the latch behind it, and a player who lifted the pause
   * lid would arrive in the world crouched with no idea why. The keyboard has
   * no such collision (`C` is gameplay-only), but the latch is shared, so one
   * call settles both.
   */
  clearCrouchToggle(): void {
    this.crouchLatched = false;
  }

  /**
   * Drops the latched (L3) sprint. Shift is untouched, for the same reason
   * Ctrl is above: a held key is a live ask, not a latch.
   *
   * `Player` calls this the frame a sprint actually ends, whatever ended it —
   * the stick coming back to centre, an optic coming up, a reload. A latch
   * that outlived its own state would make the next step out of cover a
   * sprint, which is the opposite of what the player asked for by stopping.
   */
  clearSprintToggle(): void {
    this.padSprintOn = false;
  }

  /**
   * Fires a dual-rumble pulse on the connected gamepad. Silently no-ops when
   * there is no pad, when the browser/controller has no haptics actuator, or
   * when the effect is rejected (e.g. the tab is unfocused). A new pulse
   * preempts the one still playing — that is what makes full-auto fire read
   * as a continuous buzz instead of a queue of echoes firing after the
   * trigger is released. Magnitudes are clamped to 0..1.
   */
  rumble(strong: number, weak: number, durationMs: number): void {
    if (!CONFIG.rumble.enabled) return;
    const actuator = this.readGamepad()?.vibrationActuator;
    if (!actuator) return;
    actuator
      .playEffect("dual-rumble", {
        duration: durationMs,
        strongMagnitude: clamp(strong, 0, 1),
        weakMagnitude: clamp(weak, 0, 1),
      })
      .catch(() => {
        // Preempted or unsupported — haptics never propagate failure.
      });
  }

  private readGamepad(): Gamepad | null {
    if (!navigator.getGamepads) return null;
    for (const pad of navigator.getGamepads()) {
      if (pad && pad.connected) return pad;
    }
    return null;
  }
}

/**
 * Every `KeyboardEvent.code` the game binds — the list `update()` reads, and
 * the list whose browser default is suppressed on keydown. Keep the two in
 * step: a binding missing from here keeps whatever the browser does with it.
 *
 * Suppressing the default for a bound key has to be the blanket rule rather
 * than a list of known-bad combinations, because crouch is Ctrl and the
 * movement keys are letters, so ordinary play types out browser shortcuts by
 * accident. Ctrl+D (crouch + strafe right) bookmarks the page, Ctrl+R
 * (crouch + reload) reloads the tab, Ctrl+S (crouch + back) opens a save
 * dialog, Ctrl+A (crouch + strafe left) selects the document. Bare keys are
 * no better: Space scrolls and Tab walks focus off the canvas. Chrome lets
 * all of those be prevented.
 *
 * What it CANNOT save you from is the shortcuts the browser reserves —
 * Ctrl+W, Ctrl+T, Ctrl+N, Cmd+Q — which no page-level handler ever sees.
 * Those need `navigator.keyboard.lock()`, which requires fullscreen. The
 * weapon keys are in that trap and cannot be got out of it: crouch is Ctrl and
 * Ctrl+1/Ctrl+2 switch browser TAB, so drawing the sidearm out of a crouch
 * with the number keys leaves the game. The wheel is immune, which is the
 * other reason it is the one this game names first.
 */
const BOUND_CODES = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyR",
  "KeyC",
  "KeyG",
  "KeyL",
  "Digit1",
  "Digit2",
  // Ctrl+O is the file-open dialog, and crouch is Ctrl — exactly the accident
  // the note above describes, so the settings key has to be suppressed too.
  "KeyO",
  "Space",
  "Tab",
  "Backspace",
  "Enter",
  "NumpadEnter",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
]);

/**
 * True when the key is going into a form control, in which case the browser's
 * default IS the wanted behaviour. The editor's inspector is full of text and
 * number inputs, and the bound set covers Tab, Enter, Space, the arrows and
 * most of the alphabet a name is spelled with.
 */
function isTyping(target: EventTarget | null): boolean {
  const tag = (target as HTMLElement | null)?.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
}

/** One axis of menu navigation: the direction held, and when it repeats next. */
interface NavAxis {
  /** -1, 0 or 1 — what the axis was holding on the previous frame. */
  dir: number;
  /** Wall-clock seconds at which a held direction fires again. */
  next: number;
}

/**
 * Turns a held direction into the edge-and-repeat a menu reads: the frame it
 * changes fires immediately, and holding it fires again every
 * `menuRepeatInterval` once `menuRepeatDelay` has passed. Returns the
 * direction on a firing frame and 0 otherwise.
 *
 * The clock is the wall clock rather than an accumulated `dt`, deliberately:
 * the states that read this are the ones where the game's own clock is a lid
 * (a pause) or a countdown (the deploy wait), and how long a thumb has been
 * pushing a stick is a fact about the thumb.
 */
function stepNav(axis: NavAxis, dir: number, now: number): number {
  if (dir === 0) {
    axis.dir = 0;
    return 0;
  }
  if (dir !== axis.dir) {
    axis.dir = dir;
    axis.next = now + CONFIG.input.menuRepeatDelay;
    return dir;
  }
  if (now < axis.next) return 0;
  axis.next = now + CONFIG.input.menuRepeatInterval;
  return dir;
}

function applyDeadzone(v: number, dz: number): number {
  const a = Math.abs(v);
  if (a < dz) return 0;
  return (Math.sign(v) * (a - dz)) / (1 - dz);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Maps MouseEvent.button (0/1/2) to the `buttons` bitmask (1/4/2). */
function mouseButtonBit(button: number): number {
  switch (button) {
    case 0:
      return 1;
    case 1:
      return 4;
    case 2:
      return 2;
    default:
      return 0;
  }
}

function buttonHeld(pad: Gamepad, index: number, threshold: number): boolean {
  const b = pad.buttons[index];
  if (!b) return false;
  return b.pressed || b.value > threshold;
}
