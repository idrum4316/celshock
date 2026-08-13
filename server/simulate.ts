/**
 * server/simulate.ts — Runs a whole Conquest round headlessly and prints what
 * happened. `npm run simulate [map] [difficulty] [rounds]`.
 *
 * This is the server's equivalent of playing a round, and it is the only way to
 * see the simulation on its own — no clients, no rendering, no wall clock. A
 * round that takes twelve minutes to play takes a few seconds here, which makes
 * it the practical tool for the questions that need a whole round to answer:
 * does the bake navigate, do bots find each other, does the bleed end a match.
 *
 * It is NOT a balance oracle. `CONFIG.conquest.tickets` is sized against real
 * play, and this runs with nobody in the fight — sixteen bots is not eight bots
 * and eight people. Read it for "did the round work", not for "is the round
 * fair".
 */
import { TICK_HZ } from "../src/net/protocol";
import { CONFIG } from "../src/config";
import { MAPS } from "../src/world/maps";
import { HeadlessGame } from "./HeadlessGame";

/** Give up rather than spin forever if a round somehow cannot end. */
const MAX_SIM_MINUTES = 45;

async function runRound(mapId: string, difficulty: number) {
  const def = MAPS.find((m) => m.id === mapId);
  if (!def) throw new Error(`no map "${mapId}" (have ${MAPS.map((m) => m.id).join(", ")})`);

  const game = new HeadlessGame();
  const captures: string[] = [];
  let blasts = 0;
  game.onExplosion = () => blasts++;
  game.conquest.onCaptured = (point, by) =>
    captures.push(`${point.def.id}->${by}`);

  const built = Date.now();
  await game.startRound(def, difficulty);
  const buildMs = Date.now() - built;

  const dt = 1 / TICK_HZ;
  const maxTicks = MAX_SIM_MINUTES * 60 * TICK_HZ;
  const started = Date.now();
  let ticks = 0;
  while (game.step(dt)) {
    if (++ticks > maxTicks) break;
  }
  const wallMs = Date.now() - started;

  const result = {
    map: def.name,
    difficulty,
    buildMs,
    wallMs,
    ticks,
    simSeconds: ticks / TICK_HZ,
    winner: game.conquest.winner,
    tickets: [...game.conquest.tickets] as [number, number],
    kills: [...game.kills] as [number, number],
    losses: [...game.losses] as [number, number],
    captures: captures.length,
    blasts,
    flagsHeld: [game.conquest.flagsHeld(0), game.conquest.flagsHeld(1)] as [number, number],
  };
  game.dispose();
  return result;
}

const [mapId = "hollowmere", difficulty = "1", rounds = "1"] = process.argv.slice(2);

for (let i = 0; i < Number(rounds); i++) {
  const r = await runRound(mapId, Number(difficulty));
  const mins = (r.simSeconds / 60).toFixed(1);
  console.log(
    [
      `${r.map} (difficulty ${r.difficulty})`,
      `  world built in ${r.buildMs} ms`,
      `  round ran ${r.ticks} ticks = ${mins} min of game time in ${r.wallMs} ms of wall clock`,
      `  winner: ${r.winner === null ? "NONE (hit the cap)" : CONFIG.teams[r.winner].name}`,
      `  tickets: ${r.tickets[0]} / ${r.tickets[1]}`,
      `  kills:   ${r.kills[0]} / ${r.kills[1]}`,
      `  losses:  ${r.losses[0]} / ${r.losses[1]}`,
      `  flags held at the end: ${r.flagsHeld[0]} / ${r.flagsHeld[1]}`,
      `  flag captures during the round: ${r.captures}`,
      `  grenades detonated: ${r.blasts}`,
    ].join("\n"),
  );
}
