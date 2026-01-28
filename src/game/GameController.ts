import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import { V } from "../core/Vector";
import { Boat } from "./boat/Boat";
import { PlayerBoatController } from "./boat/PlayerBoatController";
import { CameraController } from "./CameraController";
import { MainMenu } from "./menu/MainMenu";
import { TimeOfDay } from "./time/TimeOfDay";
import { isTutorialCompleted, TutorialManager } from "./tutorial";
import { DebugRenderer } from "./debug-renderer";
import { WorldManager } from "./world/WorldManager";
import { SurfaceRenderer } from "./world/rendering/SurfaceRenderer";

const MENU_ZOOM = 2; // Wide shot for menu
const GAMEPLAY_ZOOM = 5; // Normal gameplay zoom

export class GameController extends BaseEntity {
  id = "gameController";
  persistenceLevel = 100;

  @on("add")
  onAdd() {
    // Initialize world manager with default wind
    this.game.addEntity(
      new WorldManager({
        baseWind: V(5, 0), // 5 m/s from the west
      }),
    );

    // Initialize surface renderer
    this.game.addEntity(new SurfaceRenderer());

    // Time system
    this.game.addEntity(new TimeOfDay());

    // Debug visualization
    this.game.addEntity(new DebugRenderer());

    // Start with wide camera shot for menu
    this.game.camera.z = MENU_ZOOM;

    // Spawn main menu
    this.game.addEntity(new MainMenu());
  }

  @on("gameStart")
  onGameStart() {
    // Spawn boat and controls
    const boat = this.game.addEntity(new Boat());
    this.game.addEntity(new PlayerBoatController(boat));

    // Spawn camera controller with zoom transition
    const cameraController = this.game.addEntity(
      new CameraController(boat, this.game.camera),
    );
    cameraController.setZoomTarget(GAMEPLAY_ZOOM);

    // Start the tutorial if not already completed
    if (!isTutorialCompleted()) {
      boat.anchor.deploy(); // Start with anchor deployed for tutorial
      this.game.addEntity(new TutorialManager());
    }
  }
}
