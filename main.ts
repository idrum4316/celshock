import { Game } from "./src/core/Game";

window.addEventListener("DOMContentLoaded", () => {
  const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
  new Game(canvas);
});
