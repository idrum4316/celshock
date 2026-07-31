/**
 * editor/selection.ts — What "the selected thing" means, and how clicking the
 * scene finds it.
 * Owns: SelectionRef, the pick, and the selection highlight.
 *
 * The pick uses a PREDICATE on `metadata.editorRef` rather than relying on
 * `isPickable`. That is the load-bearing detail of this file: Babylon skips
 * the isPickable test entirely when a predicate is supplied, so the editor can
 * click visual meshes without MapBuilder ever making them pickable. The
 * visual/collider split — the single most load-bearing rule in the world layer
 * — is untouched by the editor's existence.
 */
import {
  Color3,
  Mesh,
  type AbstractMesh,
  type Scene,
} from "@babylonjs/core";
import type { EditorRef } from "../world/MapBuilder";
import { EDITOR } from "./tuning";

/**
 * Which layout array, and where in it. `EditorRef` (what MapBuilder tags real
 * geometry with) is a subset: the rest come from proxy meshes.
 */
export type SelectionRef =
  | EditorRef
  | { list: "controlPoints"; index: number }
  | { list: "spawns"; index: number }
  | { list: "water"; index: number }
  | { list: "grass"; index: number };

export type SelectionList = SelectionRef["list"];

export function sameRef(a: SelectionRef | null, b: SelectionRef | null): boolean {
  if (!a || !b) return a === b;
  return a.list === b.list && a.index === b.index;
}

function refOf(mesh: AbstractMesh): SelectionRef | null {
  const ref = mesh.metadata?.editorRef as SelectionRef | undefined;
  return ref ?? null;
}

/**
 * What the pointer is over, or null. Picks against anything tagged, which is
 * every placement, scatter field, and proxy — and nothing else in the scene.
 */
export function pickRef(scene: Scene, x: number, y: number): SelectionRef | null {
  const hit = scene.pick(x, y, (m) => m.metadata?.editorRef !== undefined);
  return hit?.pickedMesh ? refOf(hit.pickedMesh) : null;
}

/**
 * Outlines the selected item's meshes using Babylon's edge renderer.
 *
 * Deliberately NOT the cel outline (`addOutline`): that is a back-face shell
 * whose width is managed globally by `updateOutlineScales`, so borrowing it
 * for selection would fight the renderer over every mesh it touches every
 * frame. Edges are a separate pass and cost nothing here.
 */
export class SelectionHighlight {
  private lit: Mesh[] = [];

  clear(): void {
    for (const m of this.lit) {
      if (!m.isDisposed()) m.disableEdgesRendering();
    }
    this.lit = [];
  }

  show(meshes: readonly Mesh[]): void {
    this.clear();
    const c = Color3.FromHexString(EDITOR.colors.selection);
    for (const m of meshes) {
      if (m.isDisposed()) continue;
      m.edgesWidth = 6;
      m.edgesColor = c.toColor4(1);
      m.enableEdgesRendering(0.999);
      this.lit.push(m);
    }
  }
}
