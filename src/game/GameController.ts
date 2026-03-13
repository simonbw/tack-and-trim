import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import { ReactPreloader } from "../core/resources/Preloader";
import type { TreeFileData } from "../pipeline/mesh-building/TreeFile";
import { LevelName } from "../../resources/resources";
import { loadLevel } from "../editor/io/LevelLoader";
import { Boat } from "./boat/Boat";
import { PlayerBoatController } from "./boat/PlayerBoatController";
import { CameraController } from "./CameraController";
import { DebugRenderer } from "./debug-renderer/DebugRenderer";
import { GameInitializingScreen } from "./GameInitializingScreen";
import { MainMenu } from "./MainMenu";
import { NavigationHUD } from "./NavigationHUD";
import { SpeedReadout } from "./SpeedReadout";
import { SurfaceRenderer } from "./surface-rendering/SurfaceRenderer";
import { TimeOfDay } from "./time/TimeOfDay";
import { TimeOfDayHUD } from "./TimeOfDayHUD";
import { TutorialManager } from "./tutorial/TutorialManager";
import { isTutorialCompleted } from "./tutorial/tutorialStorage";
import { WavePhysicsResources } from "./wave-physics/WavePhysicsResources";
import { WindIndicator } from "./WindIndicator";
import { WindParticles } from "./WindParticles";
import { WindSoundGenerator } from "./WindSoundGenerator";
import { TerrainQueryManager } from "./world/terrain/TerrainQueryManager";
import { TerrainResources } from "./world/terrain/TerrainResources";
import { WaterQueryManager } from "./world/water/WaterQueryManager";
import { WaterResources } from "./world/water/WaterResources";
import { Tree } from "./Tree";
import { QueryCoordinator } from "./world/query/QueryCoordinator";
import { WindQueryManager } from "./world/wind/WindQueryManager";
import { WindResources } from "./world/wind/WindResources";

//#tunable("Camera") { min: 0.5, max: 10 }
let MENU_ZOOM: number = 2;
//#tunable("Camera") { min: 1, max: 20 }
let GAMEPLAY_ZOOM: number = 5;

// Fallback hardcoded tree positions for levels without a .trees file
const FALLBACK_TREES: Partial<Record<LevelName, [number, number][]>> = {
  default: [
    [300, -200],
    [100, -440],
    [-130, -170],
    [440, 60],
    [-60, 180],
    [-150, 2800],
    [200, 3100],
    [350, 2650],
  ],
  vendoviIsland: [
    [580, -280],
    [960, -80],
    [420, 420],
    [-80, 310],
    [1220, -180],
    [780, -500],
  ],
  sanJuanIslands: [
    [-14000, 4000],
    [-17000, 6500],
    [-11000, 9000],
    [-20000, 17000],
    [-22000, 20000],
    [-13500, 2000],
  ],
};

export class GameController extends BaseEntity {
  id = "gameController";
  persistenceLevel = 100;

  private currentLevel: LevelName | null = null;
  private treeData: TreeFileData | undefined;

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
    const { terrain, waves, wind, wavemeshData, windmeshData, treeData } =
      await loadLevel(levelName);
    this.treeData = treeData;
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
    const surfaceRenderer = this.game.addEntity(new SurfaceRenderer());
    this.game.addEntity(new WindIndicator());
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
    // Spawn boat and controls
    const boat = this.game.addEntity(new Boat());
    this.game.addEntity(new PlayerBoatController(boat));

    // Spawn camera controller with zoom transition
    const cameraController = this.game.addEntity(
      new CameraController(boat, this.game.camera),
    );
    cameraController.setZoomTarget(GAMEPLAY_ZOOM);

    // Spawn wind particles and sound
    this.game.addEntity(new WindParticles());
    this.game.addEntity(new WindSoundGenerator());

    // Spawn trees on landmasses (prefer generated .trees file, fall back to hardcoded)
    const treePositions: [number, number][] = this.treeData
      ? this.treeData.positions
      : (this.currentLevel != null
          ? FALLBACK_TREES[this.currentLevel]
          : undefined) ?? [];
    for (const [x, y] of treePositions) {
      this.game.addEntity(new Tree(x, y));
    }

    // Start the tutorial if not already completed
    if (!isTutorialCompleted()) {
      boat.anchor.deploy(); // Start with anchor deployed for tutorial
      this.game.addEntity(new TutorialManager());
    }
  }
}
