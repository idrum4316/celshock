import { Mesh, MeshBuilder, Scene, Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import { addOutline, CelMaterialFactory } from "../shaders/CelShader";
import type { RoomTheme } from "../themes/types";

/** A generated arena: geometry, spawn data, and the exit door. */
export class Room {
  theme: RoomTheme;
  index: number;
  isBossRoom: boolean;
  width: number;
  depth: number;
  playerSpawn: Vector3;
  playerYaw = 0; // facing the door (+z)
  enemySpawns: Vector3[] = [];
  bossSpawn: Vector3;
  obstacles: { x: number; z: number; r: number }[] = [];
  doorPos: Vector3;

  private meshes: Mesh[] = [];
  private door: Mesh;
  private doorOpen = false;

  constructor(
    theme: RoomTheme,
    index: number,
    isBossRoom: boolean,
    width: number,
    depth: number,
    meshes: Mesh[],
    door: Mesh,
  ) {
    this.theme = theme;
    this.index = index;
    this.isBossRoom = isBossRoom;
    this.width = width;
    this.depth = depth;
    this.meshes = meshes;
    this.door = door;
    this.playerSpawn = new Vector3(0, 0, -depth / 2 + 4);
    this.bossSpawn = new Vector3(0, 0, depth / 4);
    this.doorPos = new Vector3(0, 0, depth / 2 - 1);
  }

  /** Unlocks the exit: the door glows and slides into the floor. */
  open(mats: CelMaterialFactory): void {
    if (this.doorOpen) return;
    this.doorOpen = true;
    this.door.material = mats.getEmissive("#5aff7a");
    if (this.door.metadata) this.door.metadata.solid = false;
    this.door.checkCollisions = false;
  }

  get isOpen(): boolean {
    return this.doorOpen;
  }

  /** Animates the door sliding down after it opens. */
  update(dt: number): void {
    if (this.doorOpen && this.door.position.y > -5) {
      this.door.position.y -= dt * 4;
      if (this.door.position.y <= -5) this.door.isVisible = false;
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose();
    this.meshes.length = 0;
  }
}

/**
 * Procedural arena builder. Every mesh in the room comes from the given
 * theme (palette, trim, props), so rooms stay internally consistent.
 */
export class RoomGenerator {
  constructor(
    private scene: Scene,
    private mats: CelMaterialFactory,
  ) {}

  generate(theme: RoomTheme, index: number, isBossRoom: boolean): Room {
    const rc = CONFIG.room;
    const env = theme.environment;
    const width = isBossRoom ? rc.bossSize : randRange(rc.minSize, rc.maxSize);
    const depth = isBossRoom ? rc.bossSize : randRange(rc.minSize, rc.maxSize);
    const meshes: Mesh[] = [];

    const solid = (m: Mesh) => {
      m.checkCollisions = true;
      m.metadata = { solid: true };
      meshes.push(m);
    };

    // --- floor ---
    const floor = MeshBuilder.CreateBox(
      "floor",
      { width, height: 1, depth },
      this.scene,
    );
    floor.position.y = -0.5;
    floor.material = this.mats.get(env.floorColor);
    solid(floor);

    // --- walls (north wall split around the door gap) ---
    const h = rc.wallHeight;
    const t = 1;
    const dw = rc.doorWidth;
    const wallMat = this.mats.get(env.wallColor);

    const addWall = (
      name: string,
      w: number,
      d: number,
      x: number,
      z: number,
    ) => {
      const wall = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, this.scene);
      wall.position.set(x, h / 2, z);
      wall.material = wallMat;
      solid(wall);

      // Theme trim strip along the top edge.
      const trim = MeshBuilder.CreateBox(
        `${name}-trim`,
        { width: w + 0.1, height: 0.35, depth: d + 0.1 },
        this.scene,
      );
      trim.position.set(x, h + 0.15, z);
      trim.material = this.mats.get(env.wallTrimColor);
      trim.isPickable = false;
      meshes.push(trim);
    };

    const sideLen = (width - dw) / 2;
    addWall("wall-n-left", sideLen, t, -(dw / 2 + sideLen / 2), depth / 2);
    addWall("wall-n-right", sideLen, t, dw / 2 + sideLen / 2, depth / 2);
    addWall("wall-s", width + 2 * t, t, 0, -depth / 2);
    addWall("wall-e", t, depth, width / 2 + t / 2, 0);
    addWall("wall-w", t, depth, -(width / 2 + t / 2), 0);

    // --- dark corridor behind the door gap (visible once it opens) ---
    const corridor = MeshBuilder.CreateBox(
      "corridor",
      { width: dw + 2, height: h, depth: 6 },
      this.scene,
    );
    corridor.position.set(0, h / 2 - 0.01, depth / 2 + 3.5);
    corridor.material = this.mats.get("#0c0c12");
    corridor.flipFaces(true); // interior visible
    corridor.isPickable = false;
    meshes.push(corridor);

    // --- exit door (blocks the gap until the room is cleared) ---
    const door = MeshBuilder.CreateBox(
      "door",
      { width: dw, height: 4.6, depth: 0.5 },
      this.scene,
    );
    door.position.set(0, 2.3, depth / 2);
    door.material = this.mats.get("#3c3c46");
    addOutline(door, 0.05);
    solid(door);

    const room = new Room(theme, index, isBossRoom, width, depth, meshes, door);

    // --- themed props ---
    const placed: { x: number; z: number; r: number }[] = [];
    const propCountScale = isBossRoom ? 0.5 : 1;
    for (const spec of env.props) {
      const count = Math.round(
        randRange(spec.countRange[0], spec.countRange[1]) * propCountScale,
      );
      for (let i = 0; i < count; i++) {
        const scale = spec.scaleRange[0] + Math.random() * (spec.scaleRange[1] - spec.scaleRange[0]);
        const r = spec.radius * scale;
        const pos = this.findPropSpot(room, placed, r, isBossRoom);
        if (!pos) continue;

        const prop = spec.build(this.scene, this.mats);
        prop.scaling.setAll(scale);
        prop.position.x = pos.x;
        prop.position.z = pos.z;
        prop.position.y *= scale;
        prop.rotation.y = Math.random() * Math.PI * 2;
        addOutline(prop, 0.045);
        meshes.push(prop);

        placed.push({ x: pos.x, z: pos.z, r });
        if (spec.blocking) {
          // Solid for player collisions + bullets; enemies steer around it.
          prop.checkCollisions = true;
          prop.metadata = { solid: true };
          for (const child of prop.getChildMeshes()) {
            child.checkCollisions = true;
            child.metadata = { solid: true };
          }
          room.obstacles.push({ x: pos.x, z: pos.z, r });
        }
      }
    }

    // --- enemy spawn points (away from the player, outside props) ---
    const spawnCount = isBossRoom ? 4 : 14;
    let guard = 200;
    while (room.enemySpawns.length < spawnCount && guard-- > 0) {
      const x = randRange(-width / 2 + 4, width / 2 - 4);
      const z = randRange(-depth / 2 + 8, depth / 2 - 4);
      const p = new Vector3(x, 0, z);
      if (Vector3.Distance(p, room.playerSpawn) < 11) continue;
      if (room.obstacles.some((o) => dist2d(x, z, o.x, o.z) < o.r + 1.2)) continue;
      room.enemySpawns.push(p);
    }

    return room;
  }

  /** Finds a valid prop position or gives up after a few attempts. */
  private findPropSpot(
    room: Room,
    placed: { x: number; z: number; r: number }[],
    r: number,
    isBossRoom: boolean,
  ): { x: number; z: number } | null {
    for (let attempt = 0; attempt < 12; attempt++) {
      const x = randRange(-room.width / 2 + 3, room.width / 2 - 3);
      const z = randRange(-room.depth / 2 + 3, room.depth / 2 - 3);
      // Keep the player spawn, door lane, and boss arena center clear.
      if (dist2d(x, z, room.playerSpawn.x, room.playerSpawn.z) < 5) continue;
      if (z > room.depth / 2 - 6 && Math.abs(x) < 5) continue;
      if (isBossRoom && dist2d(x, z, 0, room.depth / 4) < 9) continue;
      if (placed.some((p) => dist2d(x, z, p.x, p.z) < p.r + r + 1.5)) continue;
      return { x, z };
    }
    return null;
  }
}

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function dist2d(x1: number, z1: number, x2: number, z2: number): number {
  const dx = x2 - x1;
  const dz = z2 - z1;
  return Math.sqrt(dx * dx + dz * dz);
}
