import { TextureStyle } from "pixi.js";
import Game from "../core/Game";
import FPSMeter from "../core/util/FPSMeter";
import { Boat } from "./boat/Boat";
import { Buoy } from "./Buoy";
import { CameraController } from "./CameraController";
import { GamePreloader } from "./GamePreloader";
import { Wake } from "./Wake";
import { Water } from "./Water";
import { WaterParticles } from "./WaterParticles";
import { Wind } from "./Wind";
import { WindIndicator } from "./WindIndicator";

// Do this so we can access the game from the console
declare global {
  interface Window {
    DEBUG: { game?: Game };
  }
}

const ticksPerFrame = 2;

async function main() {
  // Make the pixel art crisp
  TextureStyle.defaultOptions.scaleMode = "nearest";

  const game = new Game({ ticksPerSecond: 120 * ticksPerFrame });
  await game.init({ rendererOptions: { backgroundColor: 0x000010 } });
  // Make the game accessible from the console
  window.DEBUG = { game };

  // Clean up resources when the page is unloaded
  window.addEventListener("beforeunload", () => game.destroy());

  const preloader = game.addEntity(GamePreloader);
  await preloader.waitTillLoaded();
  preloader.destroy();

  if (process.env.NODE_ENV === "development") {
    const fpsMeter = new FPSMeter();
    game.addEntity(fpsMeter);
  }

  game.addEntity(new Water());
  game.addEntity(new Buoy(200, 0));
  game.addEntity(new Buoy(-160, 120));
  game.addEntity(new Buoy(100, -200));
  game.addEntity(new Buoy(-240, -100));
  game.addEntity(new Wind());
  game.addEntity(new WindIndicator());
  const boat = game.addEntity(new Boat());
  game.addEntity(new CameraController(boat, game.camera));
  game.addEntity(new Wake(boat));
  game.addEntity(new WaterParticles(boat));
}

window.addEventListener("load", main);
