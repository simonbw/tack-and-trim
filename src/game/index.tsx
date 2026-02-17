import "../core/tuning/TunableRegistry"; // Initialize tunable registry early
import { AutoPauser } from "../core/AutoPauser";
import { Game } from "../core/Game";
import { TuningPanel } from "../core/tuning/TuningPanel";
import { createGraphicsPanel } from "../core/util/stats-overlay/GraphicsPanel";
import { createLeanPanel } from "../core/util/stats-overlay/LeanPanel";
import { createProfilerPanel } from "../core/util/stats-overlay/ProfilerPanel";
import { StatsOverlay } from "../core/util/stats-overlay/StatsOverlay";
import { createSimulationStatsPanel } from "./stats/SimulationStatsPanel";
import { GameController } from "./GameController";
import { GamePreloader } from "./GamePreloader";
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
  game.addEntity(new TuningPanel());

  // GameController handles menu, game state, and spawning gameplay entities
  game.addEntity(new GameController());
}

window.addEventListener("load", main);
