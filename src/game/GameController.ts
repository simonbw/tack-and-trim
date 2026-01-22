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

    // Second island to the south - much larger and more dramatic
    const greatShieldIsland = createLandMass(
      [
        // NORTH SIDE - Starting from northwest, going clockwise
        // Northwest headland
        V(-800, 800),

        // North bay - moderate indentation
        V(-600, 900),
        V(-300, 1000),
        V(0, 1050),
        V(300, 1000),

        // Northeast headland
        V(600, 900),
        V(800, 800),

        // EAST SIDE - Windward shore
        V(900, 1200),

        // East bay - small notch
        V(950, 1700),
        V(900, 1800),
        V(950, 1900),

        V(900, 2400),

        // SOUTH SIDE
        // Southeast headland
        V(800, 2800),
        V(600, 2850),

        // South bay - large sheltered anchorage
        V(300, 2900),
        V(0, 2950),
        V(-300, 2900),
        V(-600, 2850),

        // Southwest headland
        V(-800, 2800),

        // WEST SIDE - Leeward shore (wind shadow)
        V(-900, 2400),
        V(-950, 1800),
        V(-950, 1200),
        V(-900, 800),
      ],
      {
        peakHeight: 12,
        beachWidth: 60,
        hillFrequency: 0.006,
        hillAmplitude: 0.3,
      },
    );

    this.game!.addEntity(new TerrainInfo([bayIsland, greatShieldIsland]));

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

    // Buoys for passage between islands and around southern island
    this.game!.addEntity(new Buoy(400, 600)); // Passage east
    this.game!.addEntity(new Buoy(-400, 600)); // Passage west
    this.game!.addEntity(new Buoy(1100, 1800)); // East side of Great Shield Island
    this.game!.addEntity(new Buoy(0, 3100)); // South of south bay
    this.game!.addEntity(new Buoy(-1100, 1800)); // West side of Great Shield Island

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
