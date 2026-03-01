import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import { ReactPreloader } from "../core/resources/Preloader";
import { LevelName } from "../../resources/resources";
import { loadLevel } from "../editor/io/LevelLoader";
import { Boat } from "./boat/Boat";
import { PlayerBoatController } from "./boat/PlayerBoatController";
import { CameraController } from "./CameraController";
import { DebugRenderer } from "./debug-renderer/DebugRenderer";
import { GameInitializingScreen } from "./GameInitializingScreen";
import { MainMenu } from "./MainMenu";
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
import { WindQueryManager } from "./world/wind/WindQueryManager";
import { WindResources } from "./world/wind/WindResources";

//#tunable("Camera") { min: 0.5, max: 10 }
let MENU_ZOOM: number = 2;
//#tunable("Camera") { min: 1, max: 20 }
let GAMEPLAY_ZOOM: number = 5;

export class GameController extends BaseEntity {
  id = "gameController";
  persistenceLevel = 100;

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
    const initScreen = this.game.addEntity(new GameInitializingScreen());

    // 1. Load level data (terrain + waves + wavemesh)
    const { terrain, waves, wavemeshData } = await loadLevel(levelName);
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
    this.game.addEntity(new WindResources());
    this.game.addEntity(new WindQueryManager());

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

  @on("gameStart")
  onGameStart() {
    // The clock
    this.game.addEntity(new TimeOfDayHUD());
    this.game.addEntity(new SpeedReadout());
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

    // Start the tutorial if not already completed
    if (!isTutorialCompleted()) {
      boat.anchor.deploy(); // Start with anchor deployed for tutorial
      this.game.addEntity(new TutorialManager());
    }
  }
}
