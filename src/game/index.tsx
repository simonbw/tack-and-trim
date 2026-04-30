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
import {
  runQueryParityCheck,
  type ParityReport,
} from "./world/query/QueryParity";
import {
  runLivePointsMicrobench,
  runQueryMicrobench,
  type LivePointsReport,
  type MicrobenchReport,
} from "./world/query/QueryMicrobench";
import {
  asyncProfiler,
  type AsyncProfileStats,
} from "../core/util/AsyncProfiler";

// Do this so we can access the game from the console
declare global {
  interface Window {
    DEBUG: {
      game?: Game;
      gameStarted?: boolean;
      toggleMSAA?: () => void;
      runQueryParityCheck?: () => Promise<ParityReport>;
      runQueryMicrobench?: () => Promise<MicrobenchReport>;
      runLivePointsMicrobench?: () => Promise<LivePointsReport>;
      getAsyncProfilerStats?: () => AsyncProfileStats[];
      /**
       * Most recently submitted per-type point count from the CPU
       * query coordinator's worker pool (or null if the pool isn't
       * present). Useful for sanity-checking what workload the
       * production benchmark is actually measuring.
       */
      getLastQueryPointCounts?: () => {
        terrain: number;
        water: number;
        wind: number;
      } | null;
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
  const params = new URLSearchParams(window.location.search);
  // ?autoStart=false keeps the animation loop stopped so the game can be
  // stepped one frame at a time from the DevTools console via
  // `window.DEBUG.game.nextFrame()` (or resumed with `game.startLoop()`).
  const autoStart = params.get("autoStart") !== "false";

  const game = new Game({
    ticksPerSecond: 120 * ticksPerFrame,
    world: new World({ substeps: 8, solverConfig: { iterations: 10 } }),
  });
  await game.init({
    rendererOptions: { backgroundColor: 0x000010 },
    autoStart,
  });
  game.setGpuTimingEnabled(true);
  // Make the game accessible from the console
  window.DEBUG = {
    game,
    toggleMSAA,
    runQueryParityCheck: () => runQueryParityCheck(game),
    runQueryMicrobench: () => runQueryMicrobench(game),
    runLivePointsMicrobench: () => runLivePointsMicrobench(game),
    getAsyncProfilerStats: () => asyncProfiler.getStats(),
    getLastQueryPointCounts: () => {
      const coord = game.entities.getById("cpuQueryCoordinator") as
        | { getPool?: () => unknown }
        | undefined;
      const pool = coord?.getPool?.() as {
        lastSubmittedPointCounts: {
          0: number;
          1: number;
          2: number;
        };
      } | null;
      if (!pool) return null;
      // Index by QueryTypeId — terrain=0, water=1, wind=2.
      return {
        terrain: pool.lastSubmittedPointCounts[0],
        water: pool.lastSubmittedPointCounts[1],
        wind: pool.lastSubmittedPointCounts[2],
      };
    },
  };

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

  // ?quickstart=true (or legacy ?profile=1) skips the menu and boots straight
  // into a level. Combine with ?level=<name>&boat=<id> to pick the level/boat,
  // and ?autoStart=false to stop at the first frame for tick-by-tick debugging.
  if (params.has("quickstart") || params.has("profile")) {
    const levelName = (params.get("level") ?? "default") as LevelName;
    const boatId = params.get("boat") ?? "shaff-s7";
    game.dispatch("boatSelected", { boatId, levelName });
  }
}

window.addEventListener("load", main);
