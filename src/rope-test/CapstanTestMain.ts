/**
 * Capstan solver smoke-test entry point.
 *
 * Minimal game instance hosting the CapstanTestController, which sets up
 * a handful of rope-network fixtures and runs the pure solver each tick.
 */

import { Game } from "../core/Game";
import { CapstanTestController } from "./CapstanTestController";

async function main() {
  const game = new Game({ ticksPerSecond: 120 });

  await game.init({
    rendererOptions: {
      backgroundColor: 0x1a1a2e,
    },
  });

  game.renderer.camera.z = 45;

  game.addEntity(new CapstanTestController());

  window.addEventListener("beforeunload", () => {
    game.destroy();
  });
}

main();
