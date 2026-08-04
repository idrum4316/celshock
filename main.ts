/**
 * main.ts — Bootstrap. Creates the Game on #game-canvas after DOMContentLoaded.
 * All game wiring lives in src/core/Game.ts; nothing else belongs here.
 *
 * The one thing that is not the Game's is the service worker (src/pwa): it is
 * what the browser offers to install the page as an app from, and it must
 * survive a Game that throws on a machine without WebGL2 — which is why it is
 * registered here, before the scene is built, rather than from inside it.
 */
import { Game } from "./src/core/Game";
import { registerServiceWorker } from "./src/pwa/register";

registerServiceWorker();

window.addEventListener("DOMContentLoaded", () => {
  const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
  new Game(canvas);
});
