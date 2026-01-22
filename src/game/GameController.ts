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
    // Phase 1: Core data entities only (no visuals yet)
    // Visual entities are added in onInfluenceFieldsReady() after computation completes

    // 1. Terrain first (required by InfluenceFieldManager)
    // Large island with a sheltered lagoon opening SE (away from NW wind)
    // Boat spawns at (0, 0) deep inside the lagoon
    const bayIsland = createLandMass(
      [
        // East headland tip - narrow lagoon entrance (~200 ft gap)
        V(100, 250),

        // East coast curving north
        V(500, 100),
        V(700, -300),
        V(650, -700),
        V(450, -1000),

        // North coast
        V(0, -1150),
        V(-450, -1000),

        // West coast curving south
        V(-650, -700),
        V(-700, -300),
        V(-500, 100),

        // West headland tip - matches east for narrow entrance
        V(-100, 250),

        // Lagoon interior - west shore going north into lagoon
        V(-120, 150),
        V(-200, -50),
        V(-280, -250),
        V(-300, -450),

        // Back of lagoon - deep inside island
        V(0, -550),

        // Lagoon interior - east shore going south to entrance
        V(300, -450),
        V(280, -250),
        V(200, -50),
        V(120, 150),
      ],
      {
        peakHeight: 8, // Tall island
        beachWidth: 40, // Wide beach zone
        hillFrequency: 0.008, // Very gentle rolling hills
        hillAmplitude: 0.25, // 25% height variation
      },
    );
    this.game!.addEntity(new TerrainInfo([bayIsland]));

    // 2. Influence fields (depends on terrain, starts async computation)
    this.game!.addEntity(new InfluenceFieldManager());

    // 3. Wind/Water data systems (no rendering, graceful null handling for influence fields)
    this.game!.addEntity(new WaterInfo());
    this.game!.addEntity(new WindInfo());
  }

  @on("influenceFieldsReady")
  onInfluenceFieldsReady() {
    // Phase 2: Visual entities (after influence field computation completes)
    this.game!.addEntity(new SurfaceRenderer());
    this.game!.addEntity(new WindIndicator());
    this.game!.addEntity(new WindVisualization());

    // Start with wide camera shot for menu
    this.game!.camera.z = MENU_ZOOM;

    // Spawn main menu
    this.game!.addEntity(new MainMenu());
  }

  @on("gameStart")
  onGameStart() {
    // Spawn buoys in open water around the island
    this.game!.addEntity(new Buoy(0, 500)); // South of lagoon entrance
    this.game!.addEntity(new Buoy(600, 400)); // Southeast
    this.game!.addEntity(new Buoy(-600, 400)); // Southwest
    this.game!.addEntity(new Buoy(900, -300)); // East of island

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
