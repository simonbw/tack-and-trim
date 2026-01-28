import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import { Boat } from "./boat/Boat";
import { PlayerBoatController } from "./boat/PlayerBoatController";
import { CameraController } from "./CameraController";
import { MainMenu } from "./menu/MainMenu";
import { TimeOfDay } from "./time/TimeOfDay";
import { isTutorialCompleted, TutorialManager } from "./tutorial";
import { DebugRenderer } from "./debug-renderer";

const MENU_ZOOM = 2; // Wide shot for menu
const GAMEPLAY_ZOOM = 5; // Normal gameplay zoom

export class GameController extends BaseEntity {
  id = "gameController";
  persistenceLevel = 100;

  @on("add")
  onAdd() {
    // TODO: Initialize new world systems (terrain, water, wind)

    // Time system
    this.game.addEntity(new TimeOfDay());

    // TODO: Initialize new world data systems

    // TODO: Wait for world systems ready before adding visuals
    // For now, add visuals immediately
    this.game.addEntity(new DebugRenderer());

    // Start with wide camera shot for menu
    this.game.camera.z = MENU_ZOOM;

    // Spawn main menu
    this.game.addEntity(new MainMenu());
  }

  @on("gameStart")
  onGameStart() {
    // TODO: Spawn buoys once new WaterInfo exists

    // Spawn boat and controls
    const boat = this.game.addEntity(new Boat());
    this.game.addEntity(new PlayerBoatController(boat));

    // Spawn camera controller with zoom transition
    const cameraController = this.game.addEntity(
      new CameraController(boat, this.game.camera),
    );
    cameraController.setZoomTarget(GAMEPLAY_ZOOM);

    // TODO: Spawn wind particles once new wind system exists

    // Start the tutorial if not already completed
    if (!isTutorialCompleted()) {
      boat.anchor.deploy(); // Start with anchor deployed for tutorial
      this.game.addEntity(new TutorialManager());
    }
  }
}
