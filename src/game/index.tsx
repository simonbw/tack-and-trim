import AutoPauser from "../core/AutoPauser";
import Game from "../core/Game";
import StatsOverlay, {
  createLeanPanel,
  createProfilerPanel,
  createGraphicsPanel,
} from "../core/util/stats-overlay";
import { createSimulationStatsPanel } from "./stats/SimulationStatsPanel";
import { Boat } from "./boat/Boat";
import { PlayerBoatController } from "./boat/PlayerBoatController";
import { Buoy } from "./Buoy";
import { CameraController } from "./CameraController";
import { GamePreloader } from "./GamePreloader";
import { PhysicsValidator } from "./PhysicsValidator";
import { WaterInfo } from "./water/WaterInfo";
import { WaterRenderer } from "./water/rendering/WaterRenderer";
import { WindInfo } from "./wind/WindInfo";
import { WindVisualization } from "./wind-visualization/WindVisualization";
import { WindIndicator } from "./WindIndicator";
import { WindParticles } from "./WindParticles";

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
  game.addEntity(new WaterInfo());
  game.addEntity(new WaterRenderer());
  game.addEntity(new Buoy(200, 0));
  game.addEntity(new Buoy(-160, 120));
  game.addEntity(new Buoy(100, -200));
  game.addEntity(new Buoy(-240, -100));
  game.addEntity(new WindInfo());
  game.addEntity(new WindIndicator());
  game.addEntity(new WindVisualization());

  const boat = game.addEntity(new Boat());
  game.addEntity(new PlayerBoatController(boat));
  game.addEntity(new CameraController(boat, game.camera));
  game.addEntity(new WindParticles());
}

window.addEventListener("load", main);
