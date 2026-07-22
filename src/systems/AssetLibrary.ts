import {
  AssetContainer,
  Mesh,
  PBRMaterial,
  Scene,
  SceneLoader,
  TransformNode,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import type { CelMaterialFactory } from "../shaders/CelShader";

/** External glTF props: file in /public/models plus target in-world height. */
const MANIFEST = [{ name: "tree", file: "tree-c.glb", height: 4.5 }] as const;

export type AssetName = (typeof MANIFEST)[number]["name"];

/**
 * Loads glTF props once into AssetContainers and stamps out per-room clones.
 * On load every imported PBR material is replaced with a cel material —
 * textured when the material has an albedo texture, flat otherwise — so
 * imports share the game's lighting, fog, and outline look.
 *
 * Loading is async; `instantiate` returns null until the container is ready,
 * so callers keep a procedural fallback.
 */
export class AssetLibrary {
  private containers = new Map<string, AssetContainer>();
  private normScale = new Map<string, number>();

  async load(scene: Scene, mats: CelMaterialFactory): Promise<void> {
    await Promise.all(
      MANIFEST.map(async (entry) => {
        const container = await SceneLoader.LoadAssetContainerAsync(
          "/models/",
          entry.file,
          scene,
        );
        for (const mesh of container.meshes) {
          const mat = mesh.material;
          if (mat instanceof PBRMaterial) {
            mesh.material = mat.albedoTexture
              ? mats.getTextured(mat.albedoTexture)
              : mats.get(mat.albedoColor.toGammaSpace().toHexString());
          }
        }

        // Measure raw height once to normalize to the manifest height.
        const probe = container.instantiateModelsToScene(undefined, false, {
          doNotInstantiate: true,
        });
        let minY = Infinity;
        let maxY = -Infinity;
        for (const root of probe.rootNodes) {
          const b = root.getHierarchyBoundingVectors(true);
          minY = Math.min(minY, b.min.y);
          maxY = Math.max(maxY, b.max.y);
        }
        probe.dispose();
        const rawHeight = Math.max(0.001, maxY - minY);

        this.normScale.set(entry.name, entry.height / rawHeight);
        this.containers.set(entry.name, container);
      }),
    );
  }

  /**
   * Clones an asset into the scene, or returns null while still loading.
   * The returned wrapper is safe for the room generator to scale/rotate;
   * the size normalization lives on an inner node.
   */
  instantiate(name: AssetName, scene: Scene): Mesh | null {
    const container = this.containers.get(name);
    if (!container) return null;

    const wrapper = new Mesh(`asset_${name}`, scene);
    const inner = new TransformNode(`asset_${name}_norm`, scene);
    inner.parent = wrapper;
    inner.scaling.setAll(this.normScale.get(name) ?? 1);

    const entries = container.instantiateModelsToScene(undefined, false, {
      doNotInstantiate: true, // clones, so outlines work per-mesh
    });
    for (const root of entries.rootNodes) root.parent = inner;
    return wrapper;
  }
}

/** Shared instance — themes reference it from their prop builders. */
export const propAssets = new AssetLibrary();
