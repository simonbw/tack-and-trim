import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import { loadDefaultTerrain } from "../editor/io/TerrainLoader";
import { Boat } from "./boat/Boat";
import { PlayerBoatController } from "./boat/PlayerBoatController";
import { Buoy } from "./Buoy";
import { CameraController } from "./CameraController";
import { MainMenu } from "./MainMenu";
import { SurfaceRenderer } from "./surface-rendering/SurfaceRenderer";
import { TimeOfDay } from "./time/TimeOfDay";
import { isTutorialCompleted, TutorialManager } from "./tutorial";
import { WindVisualization } from "./wind-visualization/WindVisualization";
import { WindIndicator } from "./WindIndicator";
import { WindParticles } from "./WindParticles";
import { InfluenceFieldManager } from "./world-data/influence/InfluenceFieldManager";
import { TerrainInfo } from "./world-data/terrain/TerrainInfo";
import { WaterInfo } from "./world-data/water/WaterInfo";
import { WindInfo } from "./world-data/wind/WindInfo";

const MENU_ZOOM = 2; // Wide shot for menu
const GAMEPLAY_ZOOM = 5; // Normal gameplay zoom

export class GameController extends BaseEntity {
  id = "gameController";
  persistenceLevel = 100;

  private surfaceRenderer: SurfaceRenderer | null = null;

  @on("add")
  onAdd() {
    // Phase 1: Core data entities only (no visuals yet)
    // Visual entities are added in onInfluenceFieldsReady() after computation completes

    // 1. Load terrain from bundled JSON resource
    const terrainDefinition = loadDefaultTerrain();
    this.game.addEntity(new TerrainInfo(terrainDefinition.contours));

    // 2. Influence fields (depends on terrain, starts async computation)
    this.game.addEntity(new InfluenceFieldManager());

    // 3. Time system (before water, so tides can query time)
    this.game.addEntity(new TimeOfDay());

    // 4. Wind/Water data systems (no rendering, graceful null handling for influence fields)
    this.game.addEntity(new WaterInfo());
    this.game.addEntity(new WindInfo());
  }

  @on("influenceFieldsReady")
  onInfluenceFieldsReady() {
    // Phase 2: Visual entities (after influence field computation completes)
    this.surfaceRenderer = this.game.addEntity(new SurfaceRenderer());
    this.game.addEntity(new WindIndicator());
    this.game.addEntity(new WindVisualization());

    // Start with wide camera shot for menu
    this.game.camera.z = MENU_ZOOM;

    // Spawn main menu
    this.game.addEntity(new MainMenu());
  }

  @on("keyDown")
  onKeyDown({ key }: { key: string }): void {
    // Toggle surface render debug mode
    if (key === "KeyB" && this.surfaceRenderer) {
      const currentMode = this.surfaceRenderer.getRenderMode();
      this.surfaceRenderer.setRenderMode((currentMode + 1) % 2);
    }
  }

  @on("gameStart")
  onGameStart() {
    // Spawn buoys in open water around the island
    this.game.addEntity(new Buoy(0, 500)); // South of lagoon entrance
    this.game.addEntity(new Buoy(600, 400)); // Southeast
    this.game.addEntity(new Buoy(-600, 400)); // Southwest
    this.game.addEntity(new Buoy(900, -300)); // East of island

    // Buoys for passage between islands and around southern island
    this.game.addEntity(new Buoy(400, 600)); // Passage east
    this.game.addEntity(new Buoy(-400, 600)); // Passage west
    this.game.addEntity(new Buoy(1100, 1800)); // East side of Great Shield Island
    this.game.addEntity(new Buoy(0, 3100)); // South of south bay
    this.game.addEntity(new Buoy(-1100, 1800)); // West side of Great Shield Island

    // Spawn boat and controls
    const boat = this.game.addEntity(new Boat());
    this.game.addEntity(new PlayerBoatController(boat));

    // Spawn camera controller with zoom transition
    const cameraController = this.game.addEntity(
      new CameraController(boat, this.game.camera),
    );
    cameraController.setZoomTarget(GAMEPLAY_ZOOM);

    // Spawn wind particles
    this.game.addEntity(new WindParticles());

    // Start the tutorial if not already completed
    if (!isTutorialCompleted()) {
      boat.anchor.deploy(); // Start with anchor deployed for tutorial
      this.game.addEntity(new TutorialManager());
    }
  }
}
