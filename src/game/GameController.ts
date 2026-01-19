import BaseEntity from "../core/entity/BaseEntity";
import { GameEventMap } from "../core/entity/Entity";
import { on } from "../core/entity/handler";
import { Boat } from "./boat/Boat";
import { BoatConfig, Sloop, StarterBoat } from "./boat/BoatConfig";
import { PlayerBoatController } from "./boat/PlayerBoatController";
import { Buoy } from "./Buoy";
import { CameraController } from "./CameraController";
import { MainMenu } from "./MainMenu";
import { WaterInfo } from "./water/WaterInfo";
import { WaterRenderer } from "./water/rendering/WaterRenderer";
import { WindInfo } from "./wind/WindInfo";
import { WindVisualization } from "./wind-visualization/WindVisualization";
import { TutorialManager } from "./tutorial";
import { WindIndicator } from "./WindIndicator";
import { WindParticles } from "./WindParticles";

const MENU_ZOOM = 2; // Wide shot for menu
const GAMEPLAY_ZOOM = 5; // Normal gameplay zoom

// Available boat types in order
const BOAT_CONFIGS: { name: string; config: BoatConfig }[] = [
  { name: "Starter Boat", config: StarterBoat },
  { name: "Sloop", config: Sloop },
];

export class GameController extends BaseEntity {
  persistenceLevel = 100;

  // Boat selection state
  private currentBoatIndex = 0;
  private unlockedBoats = new Set<number>([0]); // Start with only starter boat unlocked
  private boat: Boat | null = null;
  private boatController: PlayerBoatController | null = null;
  private cameraController: CameraController | null = null;

  @on("add")
  onAdd() {
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
    // Spawn buoys
    this.game!.addEntity(new Buoy(200, 0));
    this.game!.addEntity(new Buoy(-160, 120));
    this.game!.addEntity(new Buoy(100, -200));
    this.game!.addEntity(new Buoy(-240, -100));

    // Spawn boat and controls
    this.spawnBoat();

    // Spawn camera controller with zoom transition
    this.cameraController = this.game!.addEntity(
      new CameraController(this.boat!, this.game!.camera),
    );
    this.cameraController.setZoomTarget(GAMEPLAY_ZOOM);

    // Spawn wind particles
    this.game!.addEntity(new WindParticles());

    // Start the tutorial
    this.game!.addEntity(new TutorialManager());
  }

  /** Spawn a boat with the current config */
  private spawnBoat() {
    const config = BOAT_CONFIGS[this.currentBoatIndex].config;
    this.boat = this.game!.addEntity(new Boat(config));
    this.boat.anchor.deploy(); // Start with anchor deployed for tutorial
    this.boatController = this.game!.addEntity(
      new PlayerBoatController(this.boat),
    );
  }

  /** Switch to a different boat by index */
  private switchBoat(index: number) {
    if (index < 0 || index >= BOAT_CONFIGS.length) return;
    if (!this.unlockedBoats.has(index)) {
      console.log(`Boat "${BOAT_CONFIGS[index].name}" is locked!`);
      return;
    }

    // Store current position and angle
    const position = this.boat?.getPosition().clone();
    const angle = this.boat?.hull.body.angle ?? 0;

    // Remove old boat and controller
    if (this.boat) {
      this.boat.destroy();
    }
    if (this.boatController) {
      this.boatController.destroy();
    }

    // Switch to new boat
    this.currentBoatIndex = index;
    this.spawnBoat();

    // Restore position and angle
    if (position && this.boat) {
      this.boat.hull.body.position.set(position);
      this.boat.hull.body.angle = angle;
    }

    // Update camera to follow new boat
    if (this.cameraController && this.boat) {
      this.cameraController.setTarget(this.boat);
    }

    console.log(`Switched to: ${BOAT_CONFIGS[index].name}`);
  }

  /** Unlock a boat by index */
  private unlockBoat(index: number) {
    if (index >= 0 && index < BOAT_CONFIGS.length) {
      this.unlockedBoats.add(index);
      console.log(`Unlocked: ${BOAT_CONFIGS[index].name}`);
    }
  }

  /** Unlock all boats (cheat) */
  private unlockAllBoats() {
    for (let i = 0; i < BOAT_CONFIGS.length; i++) {
      this.unlockedBoats.add(i);
    }
    console.log("All boats unlocked!");
  }

  @on("keyDown")
  onKeyDown({ key }: GameEventMap["keyDown"]) {
    // Boat switching cheats (only during gameplay)
    if (!this.boat) return;

    // [ and ] to cycle through boats
    if (key === "BracketLeft") {
      const prevIndex =
        (this.currentBoatIndex - 1 + BOAT_CONFIGS.length) % BOAT_CONFIGS.length;
      this.switchBoat(prevIndex);
    }
    if (key === "BracketRight") {
      const nextIndex = (this.currentBoatIndex + 1) % BOAT_CONFIGS.length;
      this.switchBoat(nextIndex);
    }

    // Number keys 1-9 to select specific boats
    if (key.startsWith("Digit")) {
      const digit = parseInt(key.replace("Digit", ""), 10);
      if (digit >= 1 && digit <= BOAT_CONFIGS.length) {
        this.switchBoat(digit - 1);
      }
    }

    // U to unlock all boats
    if (key === "KeyU") {
      this.unlockAllBoats();
    }
  }
}
