import { AutoPauser } from "../core/AutoPauser";
import { Game } from "../core/Game";
import {
  StatsOverlay,
  createLeanPanel,
  createProfilerPanel,
  createGraphicsPanel,
} from "../core/util/stats-overlay";
import { createSimulationStatsPanel } from "./stats/SimulationStatsPanel";
import { GameController } from "./GameController";
import { GamePreloader } from "./menu/GamePreloader";
import { PhysicsValidator } from "./PhysicsValidator";

// Do this so we can access the game from the console
declare global {
  interface Window {
    DEBUG: { game?: Game };
  }
}

const ticksPerFrame = 2;

async function main() {
  const game = new Game({ ticksPerSecond: 120 * ticksPerFrame });
  await game.init({ rendererOptions: { backgroundColor: 0x000010 } });
  game.setGpuTimingEnabled(true);
  // Make the game accessible from the console
  window.DEBUG = { game };

  // Clean up resources when the page is unloaded
  window.addEventListener("beforeunload", () => game.destroy());

  const preloader = game.addEntity(GamePreloader);
  await preloader.waitTillLoaded();
  preloader.destroy();

  // TODO: Re-add initializing overlay once new world systems exist
  // const initOverlay = game.addEntity(new InitializingOverlay());

  // Persistent entities
  game.addEntity(
    new StatsOverlay([
      createLeanPanel(),
      createProfilerPanel(),
      createGraphicsPanel(),
      createSimulationStatsPanel(),
    ]),
  );
  game.addEntity(new AutoPauser());
  game.addEntity(new PhysicsValidator());

  // GameController handles menu, game state, and spawning gameplay entities
  game.addEntity(new GameController());

  // TODO: Wait for new world system initialization before removing overlay
}

window.addEventListener("load", main);
