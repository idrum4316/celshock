/**
 * main.ts — Bootstrap. Creates the Game on #game-canvas after DOMContentLoaded.
 * All wiring lives in src/core/Game.ts; nothing else belongs here.
 */
import { Game } from "./src/core/Game";

window.addEventListener("DOMContentLoaded", () => {
  const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
  new Game(canvas);
});
