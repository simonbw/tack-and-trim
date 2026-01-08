import AutoPauser from "../core/AutoPauser";
import Game from "../core/Game";
import DebugOverlay from "../core/util/DebugOverlay";
import { Boat } from "./boat/Boat";
import { PlayerBoatController } from "./boat/PlayerBoatController";
import { Buoy } from "./Buoy";
import { CameraController } from "./CameraController";
import { GamePreloader } from "./GamePreloader";
import { WaterInfo } from "./water/WaterInfo";
import { WaterRenderer } from "./water/WaterRenderer";
import { Wind } from "./Wind";
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
  // Make the game accessible from the console
  window.DEBUG = { game };

  // Clean up resources when the page is unloaded
  window.addEventListener("beforeunload", () => game.destroy());

  const preloader = game.addEntity(GamePreloader);
  await preloader.waitTillLoaded();
  preloader.destroy();

  game.addEntity(new DebugOverlay());
  game.addEntity(new AutoPauser());
  game.addEntity(new WaterInfo());
  game.addEntity(new WaterRenderer());
  game.addEntity(new Buoy(200, 0));
  game.addEntity(new Buoy(-160, 120));
  game.addEntity(new Buoy(100, -200));
  game.addEntity(new Buoy(-240, -100));
  game.addEntity(new Wind());
  game.addEntity(new WindIndicator());
  game.addEntity(new WindVisualization());

  const boat = game.addEntity(new Boat());
  game.addEntity(new PlayerBoatController(boat));
  game.addEntity(new CameraController(boat, game.camera));
  game.addEntity(new WindParticles());
}

window.addEventListener("load", main);
