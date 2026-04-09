/**
 * Rope pattern test page entry point.
 *
 * Initializes a minimal game instance and adds the RopeTestController
 * for interactive rope pattern preview.
 */

import { Game } from "../core/Game";
import { RopeTestController } from "./RopeTestController";

async function main() {
  const game = new Game({ ticksPerSecond: 120 });

  await game.init({
    rendererOptions: {
      backgroundColor: 0x1a1a2e,
    },
  });

  // Zoom the camera so the ropes are visible at a comfortable scale
  game.renderer.camera.z = 60;

  game.addEntity(new RopeTestController());

  window.addEventListener("beforeunload", () => {
    game.destroy();
  });
}

main();
