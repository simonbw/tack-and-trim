/**
 * Editor camera controller.
 *
 * Provides pan and zoom controls for the terrain editor:
 * - Middle-drag or Space+drag: Pan the view
 * - Scroll wheel: Zoom in/out
 * - Home key: Reset to fit all contours
 */

import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import { Camera2d } from "../core/graphics/Camera2d";
import { V, V2d } from "../core/Vector";
import { EditorTerrainDefinition } from "./io/TerrainFileFormat";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 50;
const ZOOM_SPEED = 0.1;
const PAN_SMOOTHING = 0.15;
const KEYBOARD_PAN_SPEED = 500; // World units per second at zoom=1
const KEYBOARD_ZOOM_FACTOR = 1.15;

export class EditorCameraController extends BaseEntity {
  tickLayer = "camera" as const;
  pausable = false;

  private camera: Camera2d;
  private isPanning = false;
  private lastMousePos: V2d = V();
  private targetZoom: number;

  /** Current terrain definition (for fit-to-view) */
  private terrainDefinition: EditorTerrainDefinition | null = null;

  /** Wheel event handler reference for cleanup */
  private wheelHandler: ((e: WheelEvent) => void) | null = null;

  constructor(camera: Camera2d) {
    super();
    this.camera = camera;
    this.targetZoom = camera.z;
  }

  @on("add")
  onAdd(): void {
    // Add wheel event listener to the canvas
    const canvas = this.game.renderer.canvas;
    this.wheelHandler = (e: WheelEvent) => this.handleWheel(e);
    canvas.addEventListener("wheel", this.wheelHandler, { passive: false });
  }

  @on("destroy")
  onDestroy(): void {
    // Remove wheel event listener
    if (this.wheelHandler) {
      const canvas = this.game.renderer.canvas;
      canvas.removeEventListener("wheel", this.wheelHandler);
      this.wheelHandler = null;
    }
  }

  setTerrainDefinition(definition: EditorTerrainDefinition): void {
    this.terrainDefinition = definition;
  }

  /**
   * Fit camera to show all terrain contours.
   */
  fitToTerrain(): void {
    if (
      !this.terrainDefinition ||
      this.terrainDefinition.contours.length === 0
    ) {
      // Default view if no terrain
      this.camera.setPosition(0, 0);
      this.targetZoom = 1;
      return;
    }

    // Find bounding box of all contours
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const contour of this.terrainDefinition.contours) {
      for (const pt of contour.controlPoints) {
        minX = Math.min(minX, pt.x);
        maxX = Math.max(maxX, pt.x);
        minY = Math.min(minY, pt.y);
        maxY = Math.max(maxY, pt.y);
      }
    }

    // Center camera on bounding box
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    this.camera.setPosition(centerX, centerY);

    // Calculate zoom to fit bounding box with padding
    const width = maxX - minX;
    const height = maxY - minY;
    const viewportSize = this.camera.getViewportSize();
    const padding = 1.2; // 20% padding

    const zoomX = viewportSize.x / (width * padding);
    const zoomY = viewportSize.y / (height * padding);
    this.targetZoom = Math.min(zoomX, zoomY, MAX_ZOOM);
    this.targetZoom = Math.max(this.targetZoom, MIN_ZOOM);
  }

  @on("tick")
  onTick(dt: number): void {
    // Smooth zoom
    this.camera.smoothZoom(this.targetZoom, PAN_SMOOTHING);

    // Keyboard panning (WASD / Arrow keys)
    const io = this.game.io;
    const movement = io.getMovementVector();

    if (movement.x !== 0 || movement.y !== 0) {
      const speed = (KEYBOARD_PAN_SPEED / this.camera.z) * dt;
      this.camera.x += movement.x * speed;
      this.camera.y += movement.y * speed;
    }
  }

  @on("mouseDown")
  onMouseDown(): void {
    const io = this.game.io;

    // Middle mouse button or Space + left click starts panning
    if (io.mmb || (io.isKeyDown("Space") && io.lmb)) {
      this.isPanning = true;
      this.lastMousePos.set(io.mousePosition);
    }
  }

  @on("mouseUp")
  onMouseUp(): void {
    this.isPanning = false;
  }

  @on("render")
  onRender(): void {
    if (!this.isPanning) return;

    const io = this.game.io;
    const mousePos = io.mousePosition;

    // Calculate world-space delta
    const lastWorld = this.camera.toWorld(this.lastMousePos);
    const currentWorld = this.camera.toWorld(mousePos);

    const deltaX = lastWorld.x - currentWorld.x;
    const deltaY = lastWorld.y - currentWorld.y;

    // Update camera position
    this.camera.x += deltaX;
    this.camera.y += deltaY;

    this.lastMousePos.set(mousePos);
  }

  private handleWheel(e: WheelEvent): void {
    e.preventDefault();

    const io = this.game.io;
    const mousePos = V(io.mousePosition.x, io.mousePosition.y);

    // Get world position under mouse before zoom
    const worldPosBefore = this.camera.toWorld(mousePos);

    // Adjust zoom
    const zoomDelta = e.deltaY > 0 ? -ZOOM_SPEED : ZOOM_SPEED;
    this.targetZoom *= 1 + zoomDelta;
    this.targetZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.targetZoom));

    // Apply zoom immediately for position calculation
    this.camera.z = this.targetZoom;

    // Get world position under mouse after zoom
    const worldPosAfter = this.camera.toWorld(mousePos);

    // Adjust camera position to keep mouse over same world point
    this.camera.x += worldPosBefore.x - worldPosAfter.x;
    this.camera.y += worldPosBefore.y - worldPosAfter.y;
  }

  @on("keyDown")
  onKeyDown({ key }: { key: string }): void {
    if (key === "Home") {
      this.fitToTerrain();
    }
    // Zoom in with = or +
    if (key === "Equal" || key === "NumpadAdd") {
      this.targetZoom *= KEYBOARD_ZOOM_FACTOR;
      this.targetZoom = Math.min(MAX_ZOOM, this.targetZoom);
    }
    // Zoom out with - or numpad minus
    if (key === "Minus" || key === "NumpadSubtract") {
      this.targetZoom /= KEYBOARD_ZOOM_FACTOR;
      this.targetZoom = Math.max(MIN_ZOOM, this.targetZoom);
    }
  }
}
