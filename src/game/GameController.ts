import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import { V, V2d } from "../core/Vector";
import { Boat } from "./boat/Boat";
import { PlayerBoatController } from "./boat/PlayerBoatController";
import { Buoy } from "./Buoy";
import { CameraController } from "./CameraController";
import { MainMenu } from "./MainMenu";
import { SurfaceRenderer } from "./surface-rendering/SurfaceRenderer";
import { isTutorialCompleted, TutorialManager } from "./tutorial";
import { WindVisualization } from "./wind-visualization/WindVisualization";
import { WindIndicator } from "./WindIndicator";
import { WindParticles } from "./WindParticles";
import { InfluenceFieldManager } from "./world-data/influence/InfluenceFieldManager";
import { createContour, TerrainContour } from "./world-data/terrain/LandMass";
import { TerrainInfo } from "./world-data/terrain/TerrainInfo";
import { WaterInfo } from "./world-data/water/WaterInfo";
import { WindInfo } from "./world-data/wind/WindInfo";

const MENU_ZOOM = 2; // Wide shot for menu
const GAMEPLAY_ZOOM = 5; // Normal gameplay zoom

/**
 * Compute the centroid of a polygon.
 */
function computeCentroid(points: V2d[]): V2d {
  let cx = 0,
    cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  return V(cx / points.length, cy / points.length);
}

/**
 * Offset control points inward using a hybrid approach:
 * - Compute direction from each point toward the centroid
 * - Move each point by the offset distance in that direction
 *
 * This is simpler than normal-based offsetting and works better for
 * complex shapes with concave regions (like islands with lagoons).
 */
function offsetPointsInward(points: V2d[], inwardDistance: number): V2d[] {
  const n = points.length;
  if (n < 3) return [...points];

  const centroid = computeCentroid(points);
  const result: V2d[] = [];

  for (let i = 0; i < n; i++) {
    const curr = points[i];

    // Vector from current point toward centroid
    const dx = centroid.x - curr.x;
    const dy = centroid.y - curr.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 0.001) {
      result.push(curr);
      continue;
    }

    // Normalize and scale by offset distance
    const nx = dx / dist;
    const ny = dy / dist;

    result.push(V(curr.x + nx * inwardDistance, curr.y + ny * inwardDistance));
  }

  return result;
}

export class GameController extends BaseEntity {
  persistenceLevel = 100;

  @on("add")
  onAdd() {
    // Phase 1: Core data entities only (no visuals yet)
    // Visual entities are added in onInfluenceFieldsReady() after computation completes

    // 1. Terrain first (required by InfluenceFieldManager)
    // Large island with a sheltered lagoon opening SE (away from NW wind)
    // Boat spawns at (0, 0) deep inside the lagoon

    // Bay Island shoreline control points
    const bayIslandShore: V2d[] = [
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
    ];

    // Great Shield Island shoreline control points
    const greatShieldShore: V2d[] = [
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
    ];

    // Create contours for each island
    const contours: TerrainContour[] = [
      // Bay Island contours
      createContour(bayIslandShore, 0, {
        hillFrequency: 0.008,
        hillAmplitude: 0.25,
      }),
      // Great Shield Island contours (simple convex shape, offset works fine)
      createContour(greatShieldShore, 0, {
        hillFrequency: 0.006,
        hillAmplitude: 0.3,
      }),
    ];

    this.game.addEntity(new TerrainInfo(contours));

    // 2. Influence fields (depends on terrain, starts async computation)
    this.game.addEntity(new InfluenceFieldManager());

    // 3. Wind/Water data systems (no rendering, graceful null handling for influence fields)
    this.game.addEntity(new WaterInfo());
    this.game.addEntity(new WindInfo());
  }

  @on("influenceFieldsReady")
  onInfluenceFieldsReady() {
    // Phase 2: Visual entities (after influence field computation completes)
    this.game.addEntity(new SurfaceRenderer());
    this.game.addEntity(new WindIndicator());
    this.game.addEntity(new WindVisualization());

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
