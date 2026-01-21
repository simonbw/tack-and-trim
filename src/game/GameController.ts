import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import { V } from "../core/Vector";
import { Boat } from "./boat/Boat";
import { PlayerBoatController } from "./boat/PlayerBoatController";
import { Buoy } from "./Buoy";
import { CameraController } from "./CameraController";
import { MainMenu } from "./MainMenu";
import { InfluenceFieldManager } from "./world-data/influence/InfluenceFieldManager";
import { createLandMass } from "./world-data/terrain/LandMass";
import { TerrainInfo } from "./world-data/terrain/TerrainInfo";
import { WaterInfo } from "./world-data/water/WaterInfo";
import { SurfaceRenderer } from "./surface-rendering/SurfaceRenderer";
import { WindInfo } from "./world-data/wind/WindInfo";
import { WindVisualization } from "./wind-visualization/WindVisualization";
import { isTutorialCompleted, TutorialManager } from "./tutorial";
import { WindIndicator } from "./WindIndicator";
import { WindParticles } from "./WindParticles";

const MENU_ZOOM = 2; // Wide shot for menu
const GAMEPLAY_ZOOM = 5; // Normal gameplay zoom

export class GameController extends BaseEntity {
  persistenceLevel = 100;

  @on("add")
  onAdd() {
    // 1. Terrain first (required by InfluenceFieldManager)
    const testIsland = createLandMass(
      [
        V(150, -30),
        V(180, -10),
        V(190, 30),
        V(170, 60),
        V(130, 70),
        V(100, 50),
        V(90, 10),
        V(110, -20),
      ],
      {
        peakHeight: 4,
        beachWidth: 25,
        hillFrequency: 0.03,
        hillAmplitude: 0.2,
      },
    );
    this.game!.addEntity(new TerrainInfo([testIsland]));

    // 2. Influence fields (depends on terrain, used by wind/water)
    this.game!.addEntity(new InfluenceFieldManager());

    // 3. Wind/Water systems (can query influence fields)
    this.game!.addEntity(new WaterInfo());
    this.game!.addEntity(new SurfaceRenderer());
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
    // Spawn buoys
    this.game!.addEntity(new Buoy(200, 0));
    this.game!.addEntity(new Buoy(-160, 120));
    this.game!.addEntity(new Buoy(100, -200));
    this.game!.addEntity(new Buoy(-240, -100));

    // Spawn boat and controls
    const boat = this.game!.addEntity(new Boat());
    this.game!.addEntity(new PlayerBoatController(boat));

    // Spawn camera controller with zoom transition
    const cameraController = this.game!.addEntity(
      new CameraController(boat, this.game!.camera),
    );
    cameraController.setZoomTarget(GAMEPLAY_ZOOM);

    // Spawn wind particles
    this.game!.addEntity(new WindParticles());

    // Start the tutorial if not already completed
    if (!isTutorialCompleted()) {
      boat.anchor.deploy(); // Start with anchor deployed for tutorial
      this.game!.addEntity(new TutorialManager());
    }
  }
}
