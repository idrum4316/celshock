/**
 * loadout.ts — The loadout editor's markup and wiring, as two functions.
 * Owns: what a loadout row looks like and what its buttons do. Nothing else.
 *
 * It is a pair of functions rather than a component because it has to appear
 * in two overlays that manage their own DOM in opposite ways: `HUD.showMenu`
 * rewrites `#overlay.innerHTML` wholesale (so anything mounted into it is
 * destroyed on every redraw), while `DeployScreen` builds its markup once and
 * keeps it. A string plus a wiring pass suits both — each caller drops the
 * markup wherever it already writes HTML and wires it straight after.
 *
 * Deliberately absent from the pause menu: a round you are already standing
 * in is not somewhere you get to change what you are carrying. That is a rule
 * about WHERE this is rendered, so it is enforced by nobody calling it there
 * rather than by a flag here.
 */
import { CONFIG } from "../config";
import { SIGHT_IDS, type SightId } from "../entities/sights";

/**
 * What each optic is for, in the player's terms. Copy, not configuration —
 * the numbers these describe live in `CONFIG.sights`, and the magnification
 * shown on each button is read from there rather than written twice.
 */
const BLURBS: Record<SightId, string> = {
  iron: "Rear aperture over a hooded post. The widest picture on the rifle and the fastest to the shoulder — best where the fight is already close.",
  holo: "A lit ring and dot floating in a tube optic. The issued sight: enough magnification to pick a target out of the dark, little enough to swing between two.",
  scope: "Telescopic, with a duplex reticle. Slow to bring up and a tunnel to look down, and the only thing on the rifle that will show you a body at the far end of the valley.",
};

/** Formats a magnification the way a lens is marked. */
function magLabel(id: SightId): string {
  return `${CONFIG.sights[id].magnification.toFixed(1)}×`;
}

/**
 * The loadout editor, as markup. `selected` is the fitted optic; it drives
 * both the highlighted button and which blurb is shown.
 *
 * The row asks for pointer events on itself, the same carve-out the
 * difficulty picker and the pause actions get — `#hud` is
 * `pointer-events: none` so a stray click is never mistaken for a UI action,
 * and anything interactive has to opt back in.
 */
export function loadoutMarkup(selected: SightId): string {
  const opts = SIGHT_IDS.map(
    (id) => `
      <button class="lo-opt${id === selected ? " on" : ""}" data-sight="${id}">
        <b>${CONFIG.sights[id].name}</b><i>${magLabel(id)}</i>
      </button>`,
  ).join("");
  return `
    <div class="loadout frame">
      <div class="lo-head">
        <span class="lo-title">Loadout</span>
        <span class="lo-hint">&uarr; &darr; / D-pad</span>
      </div>
      <div class="lo-slot">
        <span class="lo-slot-name">Optic</span>
        <div class="lo-opts">${opts}</div>
      </div>
      <p class="lo-blurb">${BLURBS[selected]}</p>
    </div>`;
}

/**
 * Binds the buttons inside `root` — call it once after the markup lands.
 * Re-rendering is the caller's job: `pick` reports the choice and nothing
 * here changes what is on screen, so the fitted sight and the highlighted
 * button cannot disagree about who is in charge.
 */
export function wireLoadout(
  root: ParentNode,
  pick: (id: SightId) => void,
): void {
  root.querySelectorAll<HTMLElement>("button.lo-opt").forEach((btn) => {
    btn.onclick = () => pick(btn.dataset.sight as SightId);
  });
}
