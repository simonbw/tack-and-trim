import BaseEntity from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import { Boat } from "./boat/Boat";
import { PlayerBoatController } from "./boat/PlayerBoatController";
import { Buoy } from "./Buoy";
import { CameraController } from "./CameraController";
import { MainMenu } from "./MainMenu";
import {
  TerrainInfo,
  TerrainRenderer,
  BeginnersBayLandMasses,
} from "./terrain";
import { WaterInfo } from "./water/WaterInfo";
import { WaterRenderer } from "./water/rendering/WaterRenderer";
import { WindInfo } from "./wind/WindInfo";
import { WindVisualization } from "./wind-visualization/WindVisualization";
import { TutorialManager } from "./tutorial";
import { WindIndicator } from "./WindIndicator";
import { WindParticles } from "./WindParticles";

const MENU_ZOOM = 2; // Wide shot for menu
const GAMEPLAY_ZOOM = 5; // Normal gameplay zoom

export class GameController extends BaseEntity {
  persistenceLevel = 100;

  @on("add")
  onAdd() {
    // Spawn terrain system (must be before water for correct layer order)
    const terrainInfo = this.game!.addEntity(new TerrainInfo());
    for (const landMass of BeginnersBayLandMasses) {
      terrainInfo.addLandMass(landMass);
    }
    this.game!.addEntity(new TerrainRenderer());

    // Spawn water and wind systems (visible during menu)
    this.game!.addEntity(new WaterInfo());
    this.game!.addEntity(new WaterRenderer());
    this.game!.addEntity(new WindInfo());
    this.game!.addEntity(new WindIndicator());
    this.game!.addEntity(new WindVisualization());

    // Start with wide camera shot for menu
    this.game!.camera.z = MENU_ZOOM;

    // Spawn main menu
    this.game!.addEntity(new MainMenu());
  }

  @on("gameStart")
  onGameStart() {
    // Spawn buoys inside Beginner's Bay
    this.game!.addEntity(new Buoy(120, 80)); // Northeast area
    this.game!.addEntity(new Buoy(-100, 100)); // Northwest area
    this.game!.addEntity(new Buoy(0, -60)); // Near channel entrance
    this.game!.addEntity(new Buoy(-80, 0)); // West side

    // Spawn boat and controls
    const boat = this.game!.addEntity(new Boat());
    boat.anchor.deploy(); // Start with anchor deployed for tutorial
    this.game!.addEntity(new PlayerBoatController(boat));

    // Spawn camera controller with zoom transition
    const cameraController = this.game!.addEntity(
      new CameraController(boat, this.game!.camera),
    );
    cameraController.setZoomTarget(GAMEPLAY_ZOOM);

    // Spawn wind particles
    this.game!.addEntity(new WindParticles());

    // Start the tutorial
    this.game!.addEntity(new TutorialManager());
  }
}
