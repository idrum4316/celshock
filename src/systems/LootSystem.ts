import { Mesh, MeshBuilder, Scene, Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import { addOutline, CelMaterialFactory } from "../shaders/CelShader";

export type PickupKind = "health" | "damage" | "speed" | "maxhp" | "mag";

interface Pickup {
  mesh: Mesh;
  kind: PickupKind;
  t: number;
}

const POWERUPS: { kind: PickupKind; color: string }[] = [
  { kind: "damage", color: "#ff5a4f" },
  { kind: "speed", color: "#35f0ff" },
  { kind: "maxhp", color: "#8fd14f" },
  { kind: "mag", color: "#ffb400" },
];

/**
 * Roguelike loot: health orbs dropped by enemies plus a random permanent
 * (run-scoped) powerup awarded for clearing each room.
 */
export class LootSystem {
  private pickups: Pickup[] = [];

  constructor(
    private scene: Scene,
    private mats: CelMaterialFactory,
  ) {}

  spawnHealthOrb(pos: Vector3): void {
    const mesh = MeshBuilder.CreateSphere(
      "healthOrb",
      { diameter: 0.55, segments: 8 },
      this.scene,
    );
    mesh.material = this.mats.getEmissive("#5aff7a");
    this.add(mesh, "health", pos);
  }

  spawnRandomPowerup(pos: Vector3): void {
    const pick = POWERUPS[Math.floor(Math.random() * POWERUPS.length)];
    const mesh = MeshBuilder.CreateBox(
      `powerup-${pick.kind}`,
      { size: 0.6 },
      this.scene,
    );
    mesh.material = this.mats.getEmissive(pick.color);
    mesh.rotation.x = Math.PI / 4;
    mesh.rotation.z = Math.PI / 4;
    addOutline(mesh, 0.03);
    this.add(mesh, pick.kind, pos);
  }

  update(dt: number, playerPos: Vector3, onPickup: (kind: PickupKind) => void): void {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      p.t += dt;
      p.mesh.position.y = 0.8 + Math.sin(p.t * 3) * 0.2;
      p.mesh.rotation.y += dt * 2.2;

      const d = p.mesh.position.subtract(playerPos);
      d.y = 0;
      if (d.length() < CONFIG.loot.pickupRadius) {
        onPickup(p.kind);
        p.mesh.dispose();
        this.pickups.splice(i, 1);
      }
    }
  }

  clear(): void {
    for (const p of this.pickups) p.mesh.dispose();
    this.pickups.length = 0;
  }

  private add(mesh: Mesh, kind: PickupKind, pos: Vector3): void {
    mesh.position.set(pos.x, 0.8, pos.z);
    mesh.isPickable = false;
    this.pickups.push({ mesh, kind, t: Math.random() * Math.PI * 2 });
  }
}
