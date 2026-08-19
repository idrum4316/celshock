/**
 * config/teams.ts — the two sides.
 * Owns: names and the friend/foe colour read.
 * Gotcha: index 0 is the player's team everywhere in the codebase.
 */

/**
 * The two sides. Colors are the primary friend/foe read — warm amber against
 * cold crimson, both legible under blue moonlight and both still saturated
 * enough to carry in Coldharbour's afternoon.
 *
 * **This colour is worn**, and that is what fixes how saturated it is allowed
 * to be: `SoldierModel`'s kit paints the pauldrons, the bandolier and the
 * helmet band with it, so a side whose colour is a dull tone is a side with no
 * marking on it at all at fifty metres. The Blight's was `#5a4550`, a plum
 * close enough to the body's own greys to disappear into them — the sides
 * were told apart by the visor's glow and nothing else. Every other place this
 * pair appears (the deploy map, the killfeed) is a screen, where a dull colour
 * merely looks dull; the soldier is where it has to survive fog, distance and
 * three pixels of width.
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
    color: "#c8404a",
    accentColor: "#9a8390",
    eyeColor: "#ff3b3b",
  },
] as const;
