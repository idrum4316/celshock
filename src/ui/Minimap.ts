/**
 * Minimap.ts — Corner minimap: prerendered static backdrop (per map), flags,
 * friendlies, player. Canvas redrawn each frame.
 * Invariants: enemies are NEVER shown live — only briefly via reveal() when
 * they fire. That's a deliberate information-rule, not a missing feature.
 * setMap() must be called once per round to rebuild the backdrop.
 */
import type { Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import type { Bot } from "../entities/Bot";
import type { Team } from "../entities/Combatant";
import type { ControlPoint } from "../systems/ConquestSystem";
import type { GameMap } from "../world/MapBuilder";

// The "mine/theirs" palette the rest of the HUD uses. Those live in CSS,
// but canvas drawing needs them here.
const COLOR_MINE = "#ffc46b";
const COLOR_THEIRS = "#ff5a4f";
const COLOR_NEUTRAL = "#8b8f96";
const COLOR_TEXT = "#e8e8ea";

/**
 * The in-round corner minimap: a north-up, whole-map view matching the deploy
 * screen's orientation, showing the five flags, every friendly bot, and the
 * player's own position and facing.
 *
 * The static village backdrop is prerendered once per round straight from the
 * collider boxes — the same source the deploy screen draws from, so the two
 * maps can never disagree, and a layout change updates both for free.
 *
 * Enemies are deliberately NOT shown: that would be a wallhack. Instead a bot
 * that opens fire is revealed for `CONFIG.minimap.enemyRevealTime` seconds —
 * the classic "shooting gives you away" rule — via `reveal()`, wired in Game
 * to `BattleSystem.onBotFired`.
 */
export class Minimap {
  private canvas: HTMLCanvasElement;
  /**
   * The chrome around the canvas — chamfered hull and compass mark. A canvas
   * cannot carry those itself (a pseudo-element needs a container), and the
   * frame is what `setVisible` toggles, so the two can never disagree.
   */
  private frame: HTMLElement;
  private ctx: CanvasRenderingContext2D;
  /** Static backdrop (ground + footprints + home gates), rebuilt per round. */
  private base: HTMLCanvasElement | null = null;
  private mapSize: number = CONFIG.map.size;
  /** Enemy bots currently given away by their gunfire, seconds remaining. */
  private readonly revealed = new Map<Bot, number>();
  /** Accumulator driving the contested-flag pulse. */
  private pulseT = 0;

  constructor() {
    const size = CONFIG.minimap.size;
    this.canvas = document.createElement("canvas");
    this.canvas.id = "minimap";
    this.canvas.width = size;
    this.canvas.height = size;
    // Keep the CSS box and the backing store the same size, or the canvas
    // is scaled and every blip blurs.
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;

    this.frame = document.createElement("div");
    this.frame.id = "minimap-frame";
    this.frame.className = "hidden";
    this.frame.innerHTML = `<div class="hull"></div><div class="compass">N</div>`;
    // The hull is sized off the canvas, so the canvas has to be inside it.
    this.frame.insertBefore(this.canvas, this.frame.querySelector(".compass"));
    document.getElementById("hud")!.appendChild(this.frame);
    this.ctx = this.canvas.getContext("2d")!;
  }

  setVisible(visible: boolean): void {
    this.frame.classList.toggle("hidden", !visible);
  }

  /**
   * Prerenders the static backdrop. `playerTeam` is baked in now (it never
   * changes mid-round) so the home-gate diamonds can use mine/theirs colours.
   */
  setMap(map: GameMap, playerTeam: Team): void {
    this.mapSize = map.size;
    this.revealed.clear();
    const size = CONFIG.minimap.size;
    const scale = size / map.size;
    const toX = (wx: number) => (wx + map.size / 2) * scale;
    // Canvas Y grows downward and world +Z is north — flip, so north is up.
    const toY = (wz: number) => (map.size / 2 - wz) * scale;

    const base = document.createElement("canvas");
    base.width = size;
    base.height = size;
    const c = base.getContext("2d")!;

    c.fillStyle = "#0b0e12";
    c.fillRect(0, 0, size, size);

    // Building footprints, from the same collider data the deploy map draws.
    c.fillStyle = "#39434a";
    for (const b of map.colliderBoxes) {
      if (b.w > 200 || b.d > 200) continue; // ground plane and ridge
      c.save();
      c.translate(toX(b.cx), toY(b.cz));
      c.rotate(-b.rotY);
      c.fillRect(
        (-b.w / 2) * scale,
        (-b.d / 2) * scale,
        b.w * scale,
        b.d * scale,
      );
      c.restore();
    }

    // Home gates, so both ends of the map read at a glance.
    for (const s of map.spawns) {
      if (s.team === null) continue; // flag spawns are drawn per frame
      const x = toX(s.pos.x);
      const y = toY(s.pos.z);
      const color = s.team === playerTeam ? COLOR_MINE : COLOR_THEIRS;
      c.beginPath();
      c.moveTo(x, y - 3.5);
      c.lineTo(x + 3.5, y);
      c.lineTo(x, y + 3.5);
      c.lineTo(x - 3.5, y);
      c.closePath();
      c.fillStyle = color;
      c.globalAlpha = 0.65;
      c.fill();
      c.globalAlpha = 1;
    }

    this.base = base;
  }

  /** Marks an enemy as visible for a while — wired to bot gunfire in Game. */
  reveal(bot: Bot): void {
    this.revealed.set(bot, CONFIG.minimap.enemyRevealTime);
  }

  update(
    dt: number,
    playerPos: Vector3,
    playerYaw: number,
    points: ControlPoint[],
    bots: readonly Bot[],
    playerTeam: Team,
  ): void {
    if (!this.base) return;
    const c = this.ctx;
    const size = this.canvas.width;
    const scale = size / this.mapSize;
    const toX = (wx: number) => (wx + this.mapSize / 2) * scale;
    const toY = (wz: number) => (this.mapSize / 2 - wz) * scale;
    this.pulseT += dt;

    c.clearRect(0, 0, size, size);
    c.drawImage(this.base, 0, 0);

    // --- flags ---
    for (const p of points) {
      const x = toX(p.def.pos.x);
      const y = toY(p.def.pos.z);
      const r = p.def.radius * scale;
      const ownerColor =
        p.owner === null
          ? COLOR_NEUTRAL
          : p.owner === playerTeam
            ? COLOR_MINE
            : COLOR_THEIRS;

      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fillStyle = hexA(ownerColor, 0.16);
      c.fill();
      c.strokeStyle = ownerColor;
      c.lineWidth = p.contested ? 2 : 1.25;
      // A contested flag pulses so it reads from the corner of the eye.
      c.globalAlpha = p.contested
        ? 0.55 + 0.45 * Math.sin(this.pulseT * 9)
        : 1;
      c.stroke();
      c.globalAlpha = 1;

      // The meter as an arc from twelve o'clock: a full circle is owned
      // outright. Its colour is the team the meter belongs to, so a flag
      // being flipped shows the attacker's colour eating the defender's.
      if (p.meter !== 0) {
        const meterColor =
          Math.sign(p.meter) === (playerTeam === 0 ? -1 : 1)
            ? COLOR_MINE
            : COLOR_THEIRS;
        c.beginPath();
        c.arc(
          x,
          y,
          r + 2.5,
          -Math.PI / 2,
          -Math.PI / 2 + Math.abs(p.meter) * Math.PI * 2,
        );
        c.strokeStyle = meterColor;
        c.lineWidth = 2;
        c.stroke();
      }

      c.fillStyle = COLOR_TEXT;
      c.font = "bold 10px system-ui, sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(p.def.id, x, y);
    }

    // --- friendlies ---
    const mr = CONFIG.minimap;
    c.fillStyle = COLOR_MINE;
    for (const bot of bots) {
      if (!bot.alive || bot.team !== playerTeam) continue;
      c.beginPath();
      c.arc(toX(bot.position.x), toY(bot.position.z), mr.friendlyRadius, 0, Math.PI * 2);
      c.fill();
    }

    // --- enemies, only while their gunfire gives them away ---
    for (const [bot, t] of this.revealed) {
      const left = t - dt;
      if (left <= 0 || !bot.alive) {
        this.revealed.delete(bot);
        continue;
      }
      this.revealed.set(bot, left);
      c.globalAlpha = Math.min(1, left / mr.enemyFadeTime);
      c.fillStyle = COLOR_THEIRS;
      c.beginPath();
      c.arc(toX(bot.position.x), toY(bot.position.z), mr.enemyRadius, 0, Math.PI * 2);
      c.fill();
      c.globalAlpha = 1;
    }

    // --- player: view cone + arrow ---
    // World yaw 0 faces +Z (north); on the canvas north is up, and
    // rotate(yaw) turns an up-drawn arrow onto the facing direction.
    c.save();
    c.translate(toX(playerPos.x), toY(playerPos.z));
    c.rotate(playerYaw);
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, 16, -Math.PI / 2 - 0.62, -Math.PI / 2 + 0.62);
    c.closePath();
    c.fillStyle = "rgba(255, 255, 255, 0.10)";
    c.fill();
    c.beginPath();
    c.moveTo(0, -5.5);
    c.lineTo(4, 4.5);
    c.lineTo(0, 2);
    c.lineTo(-4, 4.5);
    c.closePath();
    c.fillStyle = "#ffffff";
    c.strokeStyle = "rgba(0, 0, 0, 0.8)";
    c.lineWidth = 1;
    c.fill();
    c.stroke();
    c.restore();
  }
}

/** Hex colour with an alpha channel, for the zone fills. */
function hexA(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
