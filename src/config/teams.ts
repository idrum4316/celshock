/**
 * config/teams.ts — the two sides.
 * Owns: names and the friend/foe colour read.
 * Gotcha: index 0 is the player's team everywhere in the codebase.
 */

/**
 * The two sides. Colors are the primary friend/foe read in a dark scene —
 * warm amber against cold crimson, both legible under blue moonlight.
 */
export const teams = [
  {
    name: "Wardens",
    color: "#c9a15e",
    accentColor: "#e8d3a8",
    eyeColor: "#ffc46b",
  },
  {
    name: "The Blight",
    color: "#5a4550",
    accentColor: "#9a8390",
    eyeColor: "#ff3b3b",
  },
] as const;
