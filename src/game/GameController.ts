import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import { ReactPreloader } from "../core/resources/Preloader";
import { V, V2d } from "../core/Vector";
import type { TreeFileData } from "../pipeline/mesh-building/TreeFile";
import { LevelName } from "../../resources/resources";
import { loadLevel } from "../editor/io/LevelLoader";
import { Boat } from "./boat/Boat";
import { PlayerBoatController } from "./boat/PlayerBoatController";
import { TiltDebugHUD } from "./boat/TiltDebugHUD";
import { CameraController } from "./CameraController";
import { DebugRenderer } from "./debug-renderer/DebugRenderer";
import { GameInitializingScreen } from "./GameInitializingScreen";
import { MainMenu } from "./MainMenu";
import { NavigationHUD } from "./NavigationHUD";
import { SpeedReadout } from "./SpeedReadout";
import { parseBiomeConfig } from "./surface-rendering/BiomeConfig";
import { SurfaceRenderer } from "./surface-rendering/SurfaceRenderer";
import { TimeOfDay } from "./time/TimeOfDay";
import { TimeOfDayHUD } from "./TimeOfDayHUD";
import { TutorialManager } from "./tutorial/TutorialManager";
import { isTutorialCompleted } from "./tutorial/tutorialStorage";
import { WavePhysicsResources } from "./wave-physics/WavePhysicsResources";
import { WindParticles } from "./WindParticles";
import { WindSoundGenerator } from "./WindSoundGenerator";
import { TerrainQueryManager } from "./world/terrain/TerrainQueryManager";
import { TerrainResources } from "./world/terrain/TerrainResources";
import { WaterQueryManager } from "./world/water/WaterQueryManager";
import { WaterResources } from "./world/water/WaterResources";
import { TreeManager } from "./trees/TreeManager";
import { QueryCoordinator } from "./world/query/QueryCoordinator";
import { WindQueryManager } from "./world/wind/WindQueryManager";
import { WindResources } from "./world/wind/WindResources";
import { ClothWorkerPool } from "./boat/sail/ClothWorkerPool";

//#tunable("Camera") { min: 0.5, max: 10 }
let MENU_ZOOM: number = 2;
//#tunable("Camera") { min: 1, max: 20 }
let GAMEPLAY_ZOOM: number = 5;

export class GameController extends BaseEntity {
  id = "gameController";
  persistenceLevel = 100;

  private currentLevel: LevelName | null = null;
  private treeData: TreeFileData | undefined;
  private startPosition: V2d = V(0, 0);

  @on("add")
  onAdd() {
    // Switch from asset preloader UI to main menu
    for (const preloader of [
      ...this.game.entities.byConstructor(ReactPreloader),
    ]) {
      preloader.destroy();
    }

    // Start with wide camera shot for menu
    this.game.camera.z = MENU_ZOOM;

    // Show level select menu (no level loading yet)
    this.game.addEntity(new MainMenu());
  }

  @on("levelSelected")
  async onLevelSelected({ levelName }: { levelName: LevelName }) {
    this.currentLevel = levelName;
    const initScreen = this.game.addEntity(new GameInitializingScreen());

    // 1. Load level data (terrain + waves + wavemesh + trees)
    const {
      terrain,
      waves,
      wind,
      wavemeshData,
      windmeshData,
      treeData,
      biome,
      startPosition,
    } = await loadLevel(levelName);
    this.treeData = treeData;
    this.startPosition = startPosition ?? V(0, 0);
    this.game.addEntity(new TerrainResources(terrain));
    this.game.addEntity(new TerrainQueryManager());

    // 2. Time system (before water, so tides can query time)
    this.game.addEntity(new TimeOfDay());

    // 3. Wave physics
    const wavePhysics = this.game.addEntity(
      new WavePhysicsResources(waves, wavemeshData),
    );

    // 4. Water data system (tide, modifiers, GPU buffers, wave sources)
    this.game.addEntity(new WaterResources(waves));
    this.game.addEntity(new WaterQueryManager());

    // 5. Wind data systems
    this.game.addEntity(new WindResources(windmeshData, wind));
    this.game.addEntity(new WindQueryManager());
    this.game.addEntity(new QueryCoordinator());

    // 6. Visual entities
    const surfaceRenderer = this.game.addEntity(
      new SurfaceRenderer(parseBiomeConfig(biome)),
    );
    this.game.addEntity(new DebugRenderer());

    // Wait for critical systems before starting gameplay
    await Promise.all([surfaceRenderer.whenReady(), wavePhysics.whenReady()]);

    // Release rendering and start the game
    surfaceRenderer.setEnabled(true);
    initScreen.destroy();
    this.game.dispatch("gameStart", {});
  }

  @on("keyDown")
  onKeyDown({ key }: { key: string }) {
    if (key === "Escape" && this.currentLevel !== null) {
      this.game.clearScene(99);
      this.currentLevel = null;
      this.game.camera.z = MENU_ZOOM;
      this.game.addEntity(new MainMenu());
    }
  }

  @on("gameStart")
  onGameStart() {
    // The clock
    this.game.addEntity(new TimeOfDayHUD());
    this.game.addEntity(new SpeedReadout());
    this.game.addEntity(new NavigationHUD(this.currentLevel ?? undefined));
    // Cloth worker pool for off-thread sail simulation (must exist before sails)
    this.game.addEntity(new ClothWorkerPool());
    // Spawn boat and controls
    const boat = this.game.addEntity(new Boat(this.startPosition));
    this.game.addEntity(new PlayerBoatController(boat));
    this.game.addEntity(new TiltDebugHUD());

    // Spawn camera controller with zoom transition
    const cameraController = this.game.addEntity(
      new CameraController(boat, this.game.camera),
    );
    cameraController.setZoomTarget(GAMEPLAY_ZOOM);

    // Spawn wind particles and sound
    this.game.addEntity(new WindParticles());
    this.game.addEntity(new WindSoundGenerator());

    // Spawn trees on landmasses from generated .trees file
    if (this.treeData) {
      this.game.addEntity(new TreeManager(this.treeData));
    }

    // Start the tutorial if not already completed
    if (!isTutorialCompleted()) {
      boat.anchor.deploy(); // Start with anchor deployed for tutorial
      this.game.addEntity(new TutorialManager());
    }
  }
}
