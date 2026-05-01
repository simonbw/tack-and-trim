import { LevelName } from "../../resources/resources";
import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import { ReactPreloader } from "../core/resources/Preloader";
import { V, V2d } from "../core/Vector";
import type { MissionDef, PortData } from "../editor/io/LevelFileFormat";
import { loadLevel } from "../editor/io/LevelLoader";
import type { TreeFileData } from "../pipeline/mesh-building/TreeFile";
import { Boat } from "./boat/Boat";
import { BoatDebugHUD } from "./boat/BoatDebugHUD";
import { getBoatDef } from "./catalog/BoatCatalog";
import { PlayerBoatController } from "./boat/PlayerBoatController";
import { StationHUD } from "./boat/sailor/StationHUD";
import { ClothWorkerPool } from "./boat/sail/ClothWorkerPool";
import { CameraController } from "./CameraController";
import { DebugRenderer } from "./debug-renderer/DebugRenderer";
import { GameInitializingScreen } from "./GameInitializingScreen";
import { GameOverScreen } from "./GameOverScreen";
import { LightingSystem } from "./lighting/LightingSystem";
import { MainMenu } from "./MainMenu";
import { PauseMenu } from "./PauseMenu";
import { MissionHUD } from "./mission/MissionHUD";
import { MissionManager } from "./mission/MissionManager";
import { NavigationHUD } from "./NavigationHUD";
import { applySaveData } from "./persistence/SaveDeserializer";
import { SaveManager } from "./persistence/SaveManager";
import { Port } from "./port/Port";
import { PortMenu } from "./port/PortMenu";
import { ProgressionManager } from "./progression/ProgressionManager";
import { parseBiomeConfig } from "./surface-rendering/BiomeConfig";
import { SurfaceRenderer } from "./surface-rendering/SurfaceRenderer";
import { TimeOfDay } from "./time/TimeOfDay";
import { RainParticles } from "./weather/RainParticles";
import { WeatherDirector } from "./weather/WeatherDirector";
import { WeatherState } from "./weather/WeatherState";
import { TimeOfDayHUD } from "./TimeOfDayHUD";
import { TreeManager } from "./trees/TreeManager";
import { WavePhysicsResources } from "./wave-physics/WavePhysicsResources";
import { WindParticles } from "./WindParticles";
import { WindSoundGenerator } from "./WindSoundGenerator";
import { QueryWorkerCoordinator } from "./world/query/QueryWorkerCoordinator";
import { TerrainQueryManager } from "./world/terrain/TerrainQueryManager";
import { TerrainResources } from "./world/terrain/TerrainResources";
import { WaterQueryManager } from "./world/water/WaterQueryManager";
import { WaterResources } from "./world/water/WaterResources";
import { WindQueryManager } from "./world/wind/WindQueryManager";
import { WindResources } from "./world/wind/WindResources";

//#tunable("Camera") { min: 0.5, max: 10 }
let MENU_ZOOM: number = 2;
//#tunable("Camera") { min: 1, max: 20 }
let GAMEPLAY_ZOOM: number = 8;

export class GameController extends BaseEntity {
  id = "gameController";
  persistenceLevel = 100;

  private currentLevel: LevelName | null = null;
  private selectedBoatId: string = "shaff-s7";
  private treeData: TreeFileData | undefined;
  private startPosition: V2d = V(0, 0);
  private ports: PortData[] = [];
  private missions: MissionDef[] = [];
  private portMenu: PortMenu | null = null;

  @on("add")
  onAdd() {
    // Switch from asset preloader UI to main menu
    for (const preloader of [
      ...this.game.entities.byConstructor(ReactPreloader),
    ]) {
      preloader.destroy();
    }

    // Create save manager (persists across scene clears like GameController)
    this.game.addEntity(new SaveManager());

    // Start with wide camera shot for menu
    this.game.camera.z = MENU_ZOOM;

    // Show level select menu (no level loading yet)
    this.game.addEntity(new MainMenu());
  }

  @on("boatSelected")
  async onBoatSelected({
    boatId,
    levelName,
  }: {
    boatId: string;
    levelName: LevelName;
  }) {
    this.currentLevel = levelName;
    this.selectedBoatId = boatId;
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
      ports,
      missions,
      weather,
    } = await loadLevel(levelName);
    this.treeData = treeData;
    this.startPosition = startPosition ?? V(0, 0);
    this.ports = ports ?? [];
    this.missions = missions ?? [];

    this.game.addEntity(new TerrainResources(terrain));
    this.game.addEntity(new TerrainQueryManager());

    // 2. Time system (before water, so tides can query time)
    this.game.addEntity(new TimeOfDay());
    this.game.addEntity(new WeatherState(weather?.config));
    this.game.addEntity(
      new WeatherDirector(weather?.config ?? {}, weather?.variability ?? {}),
    );

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

    // 6. Visual entities
    const surfaceRenderer = this.game.addEntity(
      new SurfaceRenderer(parseBiomeConfig(biome)),
    );
    const lightingSystem = this.game.addEntity(new LightingSystem());
    this.game.addEntity(new DebugRenderer());

    // Wait for critical systems before starting gameplay
    await Promise.all([
      surfaceRenderer.whenReady(),
      wavePhysics.whenReady(),
      lightingSystem.whenReady(),
    ]);

    // QueryWorkerCoordinator spawns workers and snapshots world state
    // (including the packed wave mesh) on onAdd — so it must run AFTER
    // wavePhysics.whenReady() resolves.
    this.game.addEntity(new QueryWorkerCoordinator());

    // Release rendering and start the game
    surfaceRenderer.setEnabled(true);
    initScreen.destroy();
    this.game.dispatch("gameStart", {});
  }

  @on("keyDown")
  onKeyDown({ key, event }: { key: string; event: KeyboardEvent }) {
    if (key !== "Escape") return;
    // If any menu already handled Escape (via preventDefault), don't open the
    // pause menu on top of the action.
    if (event.defaultPrevented) return;
    if (this.game.entities.tryGetSingleton(PauseMenu)) return;
    if (this.game.entities.tryGetSingleton(MainMenu)) return;
    if (this.portMenu) return;
    if (this.currentLevel === null) return;
    // Defer creation so the newly-added PauseMenu doesn't receive the same
    // keyDown dispatch we're inside — which would destroy it immediately.
    const game = this.game;
    queueMicrotask(() => game.addEntity(new PauseMenu()));
  }

  @on("boatSunk")
  onBoatSunk() {
    this.game.addEntity(new GameOverScreen());
  }

  @on("boatMoored")
  onBoatMoored({ portId, portName }: { portId: string; portName: string }) {
    if (this.portMenu) return;
    this.portMenu = this.game.addEntity(new PortMenu(portId, portName));
  }

  @on("boatUnmoored")
  onBoatUnmoored() {
    if (this.portMenu) {
      this.portMenu.destroy();
      this.portMenu = null;
    }
  }

  @on("restartLevel")
  onRestartLevel() {
    if (this.currentLevel) {
      this.game.clearScene(99);
      this.game.dispatch("boatSelected", {
        boatId: this.selectedBoatId,
        levelName: this.currentLevel,
      });
    }
  }

  @on("returnToMenu")
  onReturnToMenu() {
    this.game.clearScene(99);
    this.currentLevel = null;
    this.game.camera.z = MENU_ZOOM;
    this.game.addEntity(new MainMenu());
  }

  @on("gameStart")
  onGameStart() {
    // The clock
    this.game.addEntity(new TimeOfDayHUD());
    this.game.addEntity(new NavigationHUD(this.currentLevel ?? undefined));
    // Cloth worker pool for off-thread sail simulation (must exist before sails)
    this.game.addEntity(new ClothWorkerPool());

    // Progression system
    this.game.addEntity(new ProgressionManager());

    // Spawn ports
    for (const portData of this.ports) {
      this.game.addEntity(new Port(portData));
    }

    // Check for pending save data (load game flow)
    const saveManager = this.game.entities.tryGetSingleton(SaveManager);
    const pendingSave = saveManager?.consumePendingSave() ?? null;

    // Use saved position/rotation if loading, otherwise level start position
    const boatPosition = pendingSave
      ? V(pendingSave.boat.position[0], pendingSave.boat.position[1])
      : this.startPosition;
    const boatRotation = pendingSave?.boat.rotation ?? 0;

    // Spawn boat and controls
    const boatConfig = getBoatDef(this.selectedBoatId)?.baseConfig;
    const boat = this.game.addEntity(
      new Boat(boatPosition, boatConfig, boatRotation),
    );
    this.game.addEntity(new PlayerBoatController(boat));
    this.game.addEntity(new StationHUD());
    this.game.addEntity(new BoatDebugHUD());

    // Apply remaining save state (damage, bilge, anchor) after construction
    if (pendingSave) {
      applySaveData(this.game, pendingSave);
    }

    // Spawn camera controller with zoom transition
    const cameraController = this.game.addEntity(
      new CameraController(boat, this.game.camera),
    );
    cameraController.setZoomTarget(GAMEPLAY_ZOOM);

    // Spawn wind particles and sound
    this.game.addEntity(new WindParticles());
    this.game.addEntity(new RainParticles());
    this.game.addEntity(new WindSoundGenerator());

    // Spawn trees on landmasses from generated .trees file
    if (this.treeData) {
      this.game.addEntity(new TreeManager(this.treeData));
    }

    // Mission system
    if (this.missions.length > 0) {
      const missionManager = this.game.addEntity(
        new MissionManager(this.missions),
      );
      this.game.addEntity(new MissionHUD());

      // Restore mission state from save
      if (pendingSave) {
        missionManager.setState({
          completedMissionIds: pendingSave.progression.completedMissions,
          currentMissionId: pendingSave.progression.currentMission?.missionId,
          money: pendingSave.progression.money,
          revealedPortIds: pendingSave.progression.discoveredPorts,
        });
      }
    }

    // Restore progression state from save
    if (pendingSave) {
      const prog = this.game.entities.tryGetSingleton(ProgressionManager);
      if (prog) {
        prog.restoreFromSave(pendingSave.progression);
      }
    }

    // Tutorial disabled for now.

    // Signal for automated profiling / e2e scripts that gameplay is live.
    window.DEBUG.gameStarted = true;
  }
}
