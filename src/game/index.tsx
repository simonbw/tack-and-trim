import { AutoPauser } from "../core/AutoPauser";
import { Game } from "../core/Game";
import {
  isMSAAEnabled,
  setMSAAEnabled,
} from "../core/graphics/webgpu/MSAAState";
import { World } from "../core/physics/world/World";
import "../core/tuning/TunableRegistry"; // Initialize tunable registry early
import { TuningPanel } from "../core/tuning/TuningPanel";
import { createGraphicsPanel } from "../core/util/stats-overlay/GraphicsPanel";
import { createLeanPanel } from "../core/util/stats-overlay/LeanPanel";
import { createProfilerPanel } from "../core/util/stats-overlay/ProfilerPanel";
import { StatsOverlay } from "../core/util/stats-overlay/StatsOverlay";
import "../fonts.css";
import { LevelName } from "../../resources/resources";
import { GameController } from "./GameController";
import { GamePreloader } from "./GamePreloader";
import { PhysicsValidator } from "./PhysicsValidator";
import { createSimulationStatsPanel } from "./stats/SimulationStatsPanel";

// Do this so we can access the game from the console
declare global {
  interface Window {
    DEBUG: {
      game?: Game;
      gameStarted?: boolean;
      toggleMSAA?: () => void;
    };
  }
}

function toggleMSAA() {
  const next = !isMSAAEnabled();
  setMSAAEnabled(next);
  console.log(`MSAA ${next ? "enabled" : "disabled"}`);
}

const ticksPerFrame = 1;

async function main() {
  const game = new Game({
    ticksPerSecond: 120 * ticksPerFrame,
    world: new World({ substeps: 8, solverConfig: { iterations: 10 } }),
  });
  await game.init({ rendererOptions: { backgroundColor: 0x000010 } });
  game.setGpuTimingEnabled(true);
  // Make the game accessible from the console
  window.DEBUG = { game, toggleMSAA };

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

  // ?profile=1 skips the menu flow for automated profiling.
  const params = new URLSearchParams(window.location.search);
  if (params.has("profile")) {
    const levelName = (params.get("level") ?? "default") as LevelName;
    const boatId = params.get("boat") ?? "shaff-s7";
    game.dispatch("boatSelected", { boatId, levelName });
  }
}

window.addEventListener("load", main);
