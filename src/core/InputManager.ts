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
  fire = false;
  jumpPressed = false;
  reloadPressed = false;
  /**
   * Keyboard: held Shift. Gamepad: L3 toggles — holding a stick click for a
   * 240 m crossing is miserable, so the pad latches instead.
   */
  sprint = false;
  /** Held: show the scoreboard. */
  scoreboard = false;
  /** Edge-triggered "confirm" (Enter / click / gamepad A / Start). */
  confirmPressed = false;
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
  private prevConfirm = false;
  private prevPadSprint = false;
  /** Latched L3 sprint state — toggled on each L3 press, cleared on blur. */
  private padSprintOn = false;

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      // Space scrolls the page; Tab would move focus off the canvas.
      if (e.code === "Space" || e.code === "Tab") e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.pointerMask = 0;
      this.mouseMask = 0;
      this.padSprintOn = false;
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
    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === canvas;
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

    // Actions (LT=6 ADS, RT=7 shoot, A=0 jump, X=2 reload, L3=10, Start=9)
    const padAds = pad ? buttonHeld(pad, 6, trig) : false;
    const padFire = pad ? buttonHeld(pad, 7, trig) : false;
    const padJump = pad ? buttonHeld(pad, 0, trig) : false;
    const padReload = pad ? buttonHeld(pad, 2, trig) : false;
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
        padJump ||
        padReload ||
        padStart ||
        padSprint ||
        buttonHeld(pad, 8, trig));

    const buttons = this.pointerMask | this.mouseMask;
    this.ads = (buttons & 2) !== 0 || padAds;
    this.fire = (buttons & 1) !== 0 || padFire;

    // L3 toggles sprint rather than holding it — a stick click is fatiguing
    // to hold, and sprint here is traversal, not a burst.
    if (padSprint && !this.prevPadSprint) this.padSprintOn = !this.padSprintOn;
    this.prevPadSprint = padSprint;

    this.sprint =
      this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") || this.padSprintOn;
    this.altHeld = this.keys.has("AltLeft") || this.keys.has("AltRight");
    // Back / View button (6 on the standard mapping is LT, 8 is Back).
    this.scoreboard = this.keys.has("Tab") || (pad ? buttonHeld(pad, 8, trig) : false);

    const jumpNow = this.keys.has("Space") || padJump;
    this.jumpPressed = jumpNow && !this.prevJump;
    this.prevJump = jumpNow;

    const reloadNow = this.keys.has("KeyR") || padReload;
    this.reloadPressed = reloadNow && !this.prevReload;
    this.prevReload = reloadNow;

    const confirmNow =
      this.keys.has("Enter") ||
      this.keys.has("NumpadEnter") ||
      (buttons & 1) !== 0 ||
      padJump ||
      padStart;
    this.confirmPressed = confirmNow && !this.prevConfirm;
    this.prevConfirm = confirmNow;
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
