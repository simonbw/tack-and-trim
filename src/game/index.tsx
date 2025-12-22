import { TextureStyle } from "pixi.js";
import Game from "../core/Game";
import FPSMeter from "../core/util/FPSMeter";
import { Boat } from "./Boat";
import { CameraController } from "./CameraController";
import { GamePreloader } from "./GamePreloader";
import { Water } from "./Water";

// Do this so we can access the game from the console
declare global {
  interface Window {
    DEBUG: { game?: Game };
  }
}

async function main() {
  // Make the pixel art crisp
  TextureStyle.defaultOptions.scaleMode = "nearest";

  const game = new Game();
  await game.init({ rendererOptions: { backgroundColor: 0x000010 } });
  // Make the game accessible from the console
  window.DEBUG = { game };

  const preloader = game.addEntity(GamePreloader);
  await preloader.waitTillLoaded();
  preloader.destroy();

  if (process.env.NODE_ENV === "development") {
    const fpsMeter = new FPSMeter();
    game.addEntity(fpsMeter);
  }

  game.addEntity(new Water());
  const boat = game.addEntity(new Boat());
  game.addEntity(new CameraController(boat, game.camera));
}

window.addEventListener("load", main);
