import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import { loadDefaultLevel } from "../editor/io/LevelLoader";
import { Boat } from "./boat/Boat";
import { PlayerBoatController } from "./boat/PlayerBoatController";
import { Buoy } from "./Buoy";
import { CameraController } from "./CameraController";
import { MainMenu } from "./MainMenu";
import { SurfaceRenderer } from "./surface-rendering/SurfaceRenderer";
import { TimeOfDay } from "./time/TimeOfDay";
import { isTutorialCompleted, TutorialManager } from "./tutorial";
import { DebugRenderer } from "./debug-renderer";
import { WavePhysicsResources } from "./wave-physics/WavePhysicsResources";
import { WindIndicator } from "./WindIndicator";
import { WindParticles } from "./WindParticles";
import { TerrainResources } from "./world/terrain/TerrainResources";
import { TerrainQueryManager } from "./world/terrain/TerrainQuery";
import { WaterResources } from "./world/water/WaterResources";
import { WaterQueryManager } from "./world/water/WaterQuery";
import { WindResources } from "./world/wind/WindResources";
import { WindQueryManager } from "./world/wind/WindQuery";

const MENU_ZOOM = 2; // Wide shot for menu
const GAMEPLAY_ZOOM = 5; // Normal gameplay zoom

export class GameController extends BaseEntity {
  id = "gameController";
  persistenceLevel = 100;

  @on("add")
  onAdd() {
    // 1. Load level data (terrain + waves) from bundled JSON resource
    const { terrain, waves } = loadDefaultLevel();
    this.game.addEntity(new TerrainResources(terrain));
    this.game.addEntity(new TerrainQueryManager());

    // 2. Time system (before water, so tides can query time)
    this.game.addEntity(new TimeOfDay());

    // 3. Wave physics (needs terrain for shadow computation, uses wave direction)
    this.game.addEntity(new WavePhysicsResources(waves));

    // 4. Water data system (tide, modifiers, GPU buffers, wave sources)
    this.game.addEntity(new WaterResources(waves));
    this.game.addEntity(new WaterQueryManager());

    // 5. Wind data systems
    this.game.addEntity(new WindResources());
    this.game.addEntity(new WindQueryManager());

    // 6. Visual entities
    this.game.addEntity(new SurfaceRenderer());
    this.game.addEntity(new WindIndicator());
    this.game.addEntity(new DebugRenderer());

    // Start with wide camera shot for menu
    this.game.camera.z = MENU_ZOOM;

    // Spawn main menu
    this.game.addEntity(new MainMenu());
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
